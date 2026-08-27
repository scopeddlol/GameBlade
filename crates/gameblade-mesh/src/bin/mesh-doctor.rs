//! Run this on a machine you want to serve games from, before deploying
//! anything.
//!
//! It answers the only question that decides whether the mesh is worth having
//! on a given connection: can a client reach this machine directly, or will
//! every byte end up relayed back through the very proxy the mesh exists to
//! avoid?
//!
//! It sends a handful of UDP packets to public STUN servers and reads back the
//! address they saw. Nothing about the archive is disclosed — a binding request
//! has no payload, and the answer is this machine's own address, which every
//! host it talks to already sees.
//!
//!     cargo run --bin mesh-doctor

use gameblade_mesh::diagnostics::{explain, probe, DEFAULT_STUN_SERVERS};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    println!("Checking what this machine looks like from the outside…\n");

    match probe(DEFAULT_STUN_SERVERS).await {
        Ok(report) => {
            println!("{}", explain(&report));

            // A non-zero exit for the bad answer, so this can gate a deploy
            // script rather than only being read by a person.
            if !report.direct_path_likely() {
                std::process::exit(1);
            }
        }
        Err(err) => {
            eprintln!(
                "Could not complete the check: {err}\n\n\
                 If this keeps happening, outbound UDP is probably blocked on this\n\
                 network. That rules out direct transfer by itself — nothing here\n\
                 works without it."
            );
            std::process::exit(2);
        }
    }
}
