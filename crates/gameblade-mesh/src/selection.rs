//! Choosing where to fetch the next chunk from.
//!
//! The coordinator hands out a starting order, but it cannot know which node is
//! fastest for a particular client on a particular evening — that depends on
//! two home connections and everything between them. So the order it gives is
//! only what to try first, and everything after that comes from measurement.
//!
//! The rule is simple and deliberately not clever: prefer the source with the
//! best recently-observed throughput, drop a source that keeps failing, and
//! always keep the origin as the one that cannot be dropped. Elaborate
//! schedulers lose to that more often than they beat it, because the thing that
//! actually matters is noticing quickly when a source goes bad.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::error::SourceHealth;

/// How many consecutive failures retire a source.
///
/// Three: one is noise, two is bad luck, three is a pattern. Retiring too eagerly
/// costs throughput on a link that is merely flaky; retiring too late costs a
/// timeout on every chunk.
const FAILURES_BEFORE_DEAD: u32 = 3;

/// How long a retired source stays retired before it may be tried again.
///
/// A node that was down when a download started is often back before it ends,
/// and a 40 GB transfer is long enough that never reconsidering would give up
/// real bandwidth for the rest of it.
const RETIREMENT: Duration = Duration::from_secs(120);

/// What has been observed about one source.
#[derive(Debug, Clone)]
pub struct SourceStats {
    pub id: String,
    pub label: String,
    /// False for the origin, which is never retired.
    pub retirable: bool,
    pub health: SourceHealth,
    consecutive_failures: u32,
    retired_at: Option<Instant>,
    /// Exponentially smoothed, in bytes per second.
    throughput: Option<f64>,
    chunks_delivered: u64,
}

impl SourceStats {
    fn new(id: String, label: String, retirable: bool) -> Self {
        Self {
            id,
            label,
            retirable,
            health: SourceHealth::Untried,
            consecutive_failures: 0,
            retired_at: None,
            throughput: None,
            chunks_delivered: 0,
        }
    }

    pub fn throughput_bytes_per_second(&self) -> Option<f64> {
        self.throughput
    }

    pub fn chunks_delivered(&self) -> u64 {
        self.chunks_delivered
    }
}

/// The sources available for one download, and what is known about them.
pub struct SourcePool {
    sources: Vec<SourceStats>,
    /// Where in the list the next request should start looking.
    ///
    /// Kept so that with several equally good sources, work spreads across them
    /// instead of every chunk going to whichever one sorts first.
    cursor: usize,
    order: HashMap<String, usize>,
}

impl SourcePool {
    /// Build a pool. The origin must be present and is always last resort.
    pub fn new(origin_label: &str) -> Self {
        Self {
            sources: vec![SourceStats::new(
                "origin".to_string(),
                origin_label.to_string(),
                false,
            )],
            cursor: 0,
            order: HashMap::new(),
        }
    }

    /// Build a pool for a split Coordinator, where HTTP has metadata but no
    /// game bytes and therefore must never be selected as a source.
    pub fn nodes_only() -> Self {
        Self {
            sources: Vec::new(),
            cursor: 0,
            order: HashMap::new(),
        }
    }

    /// Add a node, in the coordinator's preference order.
    pub fn add_node(&mut self, id: &str, label: &str, priority: usize) {
        self.order.insert(id.to_string(), priority);
        self.sources
            .push(SourceStats::new(id.to_string(), label.to_string(), true));
    }

    pub fn sources(&self) -> &[SourceStats] {
        &self.sources
    }

    pub fn get(&self, id: &str) -> Option<&SourceStats> {
        self.sources.iter().find(|source| source.id == id)
    }

    /// Whether any node source is currently usable.
    pub fn has_live_node(&self) -> bool {
        self.sources
            .iter()
            .any(|source| source.retirable && self.is_usable(source))
    }

    /// The source that should serve the next chunk.
    ///
    /// Never returns `None`: the origin cannot be retired, so there is always an
    /// answer. That is what makes the mesh an optimisation rather than a
    /// dependency — every failure path here ends at the download that already
    /// worked before any of this existed.
    pub fn pick(&mut self) -> String {
        let usable: Vec<usize> = (0..self.sources.len())
            .filter(|index| self.is_usable(&self.sources[*index]))
            .collect();

        if usable.is_empty() {
            return "origin".to_string();
        }

        // An unmeasured source is tried once before anything is concluded about
        // it — otherwise a pool whose first source happens to be quick would
        // never discover the second one is quicker.
        if let Some(index) = usable
            .iter()
            .copied()
            .find(|index| self.sources[*index].health == SourceHealth::Untried)
        {
            return self.sources[index].id.clone();
        }

        let best = usable
            .iter()
            .copied()
            .max_by(|a, b| {
                let left = self.score(&self.sources[*a]);
                let right = self.score(&self.sources[*b]);
                left.partial_cmp(&right)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .unwrap_or(0);

        // Round-robin among sources scoring within a tenth of the best, so work
        // actually spreads instead of piling onto one node that happens to have
        // measured a fraction faster.
        let top = self.score(&self.sources[best]);
        let contenders: Vec<usize> = usable
            .into_iter()
            .filter(|index| self.score(&self.sources[*index]) >= top * 0.9)
            .collect();

        self.cursor = self.cursor.wrapping_add(1);
        let chosen = contenders[self.cursor % contenders.len()];
        self.sources[chosen].id.clone()
    }

    /// Record a chunk that arrived, and how long it took.
    pub fn record_success(&mut self, id: &str, bytes: u64, elapsed: Duration) {
        let Some(source) = self.sources.iter_mut().find(|source| source.id == id) else {
            return;
        };

        source.consecutive_failures = 0;
        source.retired_at = None;
        source.health = SourceHealth::Working;
        source.chunks_delivered += 1;

        let seconds = elapsed.as_secs_f64().max(0.001);
        let observed = bytes as f64 / seconds;

        // Smoothed rather than replaced, so one unusually fast or slow chunk
        // does not swing the choice for the rest of a long download.
        source.throughput = Some(match source.throughput {
            Some(previous) => previous * 0.7 + observed * 0.3,
            None => observed,
        });
    }

    /// Record a failure that another source might not share.
    pub fn record_failure(&mut self, id: &str) {
        let Some(source) = self.sources.iter_mut().find(|source| source.id == id) else {
            return;
        };

        source.consecutive_failures += 1;

        if source.retirable && source.consecutive_failures >= FAILURES_BEFORE_DEAD {
            source.health = SourceHealth::Dead;
            source.retired_at = Some(Instant::now());
        } else {
            source.health = SourceHealth::Degraded;
        }
    }

    /// Retire a source immediately, whatever its record.
    ///
    /// For failures that say something final — a node that refused a grant, one
    /// that turned out not to hold the game — where counting to three would
    /// just be three wasted round trips.
    pub fn retire(&mut self, id: &str) {
        if let Some(source) = self.sources.iter_mut().find(|source| source.id == id) {
            if source.retirable {
                source.health = SourceHealth::Dead;
                source.retired_at = Some(Instant::now());
            }
        }
    }

    fn is_usable(&self, source: &SourceStats) -> bool {
        match source.retired_at {
            None => true,
            // A node that was down at the start of a 40 GB transfer is often
            // back before the end of it.
            Some(at) => at.elapsed() >= RETIREMENT,
        }
    }

    /// Higher is better. Measured throughput decides; the coordinator's order
    /// only breaks ties among sources nothing is known about yet.
    fn score(&self, source: &SourceStats) -> f64 {
        match source.throughput {
            Some(rate) => rate,
            None => {
                let priority = self.order.get(&source.id).copied().unwrap_or(50);
                // Below any real measurement, so an unmeasured source never
                // outranks one that has actually delivered bytes.
                1.0 - priority as f64 / 1_000.0
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool() -> SourcePool {
        let mut pool = SourcePool::new("Origin");
        pool.add_node("nod_1", "Home archive", 0);
        pool.add_node("nod_2", "Mirror", 1);
        pool
    }

    #[test]
    fn the_origin_is_always_available() {
        // The whole design rests on this: the mesh is an optimisation, and
        // every failure path has to end somewhere that already worked.
        let mut pool = SourcePool::new("Origin");
        pool.record_failure("origin");
        pool.record_failure("origin");
        pool.record_failure("origin");
        pool.record_failure("origin");

        assert_eq!(pool.pick(), "origin");
    }

    #[test]
    fn every_source_is_tried_once_before_anything_is_concluded() {
        // A pool that settled on its first source would never find out the
        // second one is faster.
        let mut pool = pool();
        let mut seen = std::collections::HashSet::new();

        for _ in 0..3 {
            let id = pool.pick();
            seen.insert(id.clone());
            pool.record_success(&id, 1_000_000, Duration::from_millis(100));
        }

        assert_eq!(seen.len(), 3);
    }

    #[test]
    fn the_faster_source_wins_once_both_are_measured() {
        let mut pool = pool();

        // 10 MB/s against 1 MB/s.
        pool.record_success("nod_1", 10_000_000, Duration::from_secs(1));
        pool.record_success("nod_2", 1_000_000, Duration::from_secs(1));
        pool.record_success("origin", 500_000, Duration::from_secs(1));

        let picks: Vec<String> = (0..10).map(|_| pool.pick()).collect();
        assert!(picks.iter().filter(|id| *id == "nod_1").count() >= 8);
    }

    #[test]
    fn work_spreads_across_sources_that_measure_alike() {
        // Otherwise two equally good nodes would leave one of them idle.
        let mut pool = pool();
        for _ in 0..3 {
            pool.record_success("nod_1", 10_000_000, Duration::from_secs(1));
            pool.record_success("nod_2", 10_000_000, Duration::from_secs(1));
            pool.record_success("origin", 10_000_000, Duration::from_secs(1));
        }

        let picks: std::collections::HashSet<String> = (0..12).map(|_| pool.pick()).collect();
        assert!(picks.len() >= 2);
    }

    #[test]
    fn three_failures_retire_a_node() {
        let mut pool = pool();

        pool.record_failure("nod_1");
        assert!(pool.has_live_node());
        pool.record_failure("nod_1");
        assert!(pool.has_live_node());
        pool.record_failure("nod_1");

        assert_eq!(pool.get("nod_1").unwrap().health, SourceHealth::Dead);
        // nod_2 is untouched: one node failing says nothing about another.
        assert!(pool.has_live_node());
    }

    #[test]
    fn a_success_forgives_earlier_failures() {
        // A flaky link that recovers should not be retired by failures it has
        // already made up for.
        let mut pool = pool();

        pool.record_failure("nod_1");
        pool.record_failure("nod_1");
        pool.record_success("nod_1", 1_000, Duration::from_millis(10));
        pool.record_failure("nod_1");
        pool.record_failure("nod_1");

        assert_ne!(pool.get("nod_1").unwrap().health, SourceHealth::Dead);
    }

    #[test]
    fn a_final_failure_retires_a_node_without_counting_to_three() {
        // A refused grant will be refused twice more; those are wasted trips.
        let mut pool = pool();
        pool.retire("nod_1");

        assert_eq!(pool.get("nod_1").unwrap().health, SourceHealth::Dead);
    }

    #[test]
    fn the_origin_cannot_be_retired_even_explicitly() {
        let mut pool = pool();
        pool.retire("origin");

        assert_ne!(pool.get("origin").unwrap().health, SourceHealth::Dead);
        assert!(!SourcePool::new("Origin").sources()[0].retirable);
    }

    #[test]
    fn with_every_node_retired_the_pool_falls_back_to_the_origin() {
        let mut pool = pool();
        pool.retire("nod_1");
        pool.retire("nod_2");

        assert!(!pool.has_live_node());
        assert_eq!(pool.pick(), "origin");
    }

    #[test]
    fn throughput_is_smoothed_rather_than_replaced() {
        // One slow chunk on an otherwise fast node should not hand the whole
        // download to a slower source.
        let mut pool = pool();

        pool.record_success("nod_1", 10_000_000, Duration::from_secs(1));
        pool.record_success("nod_1", 100_000, Duration::from_secs(1));

        let rate = pool
            .get("nod_1")
            .unwrap()
            .throughput_bytes_per_second()
            .unwrap();
        assert!(
            rate > 5_000_000.0,
            "one slow chunk swung the estimate to {rate}"
        );
    }

    #[test]
    fn an_unmeasured_source_never_outranks_one_that_has_delivered() {
        let mut pool = pool();
        pool.record_success("nod_1", 1_000, Duration::from_secs(1));

        // nod_2 and origin are still untried, so they get their one trial each,
        // but the scoring itself must not prefer them.
        assert!(pool.score(pool.get("nod_1").unwrap()) > pool.score(pool.get("nod_2").unwrap()));
    }

    #[test]
    fn recording_against_an_unknown_source_is_ignored_rather_than_panicking() {
        // Sources come from the coordinator and can change mid-download.
        let mut pool = pool();
        pool.record_success("nod_gone", 1, Duration::from_secs(1));
        pool.record_failure("nod_gone");
        pool.retire("nod_gone");
    }
}
