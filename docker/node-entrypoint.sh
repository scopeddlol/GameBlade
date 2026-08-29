#!/bin/sh
# The two halves of a node, in one container.
#
# A node is a scanner that reports what it holds and an agent that serves it,
# and they are separate processes because one is Node and the other is Rust —
# not because an operator should have to know that. Two compose services for one
# machine meant two places to mount the same library, two places to get the same
# state path right, and a node that half-worked whenever those disagreed.
#
# So: one image, one service, both processes. tini is PID 1 and reaps whatever
# these leave behind; this script's only jobs are to start them, to take the
# container down if either dies, and to pass a signal on so a shutdown is clean.
#
# Exiting when either half dies is deliberate. Docker's restart policy brings
# both back together, which is the only state worth being in: a node whose agent
# has died serves nothing, and one whose scanner has died stops reporting and
# goes stale. Neither is worth keeping half-alive, and both look healthy from
# outside while they do it.
#
# Plain POSIX shell throughout — no `wait -n`, which is a bash builtin that only
# some BusyBox builds have. This is the first thing that runs on a node, and a
# node that will not start because its entrypoint used a shell feature the base
# image happened not to ship is a bad way to spend a deployment.
set -u

server_pid=''
agent_pid=''

stop_both() {
    [ -n "$server_pid" ] && kill -TERM "$server_pid" 2>/dev/null
    [ -n "$agent_pid" ] && kill -TERM "$agent_pid" 2>/dev/null
    return 0
}

# A signal from Docker is a deliberate shutdown: pass it on and let both close
# in their own time rather than being killed outright mid-transfer.
on_signal() {
    stop_both
    wait
    exit 0
}
trap on_signal TERM INT

node dist/index.js &
server_pid=$!

gameblade-node &
agent_pid=$!

echo "node: server pid $server_pid, mesh agent pid $agent_pid" >&2

# Watch both. `sleep` runs in the background and is waited on, so a signal
# arriving mid-interval is handled at once instead of up to a second later.
while :; do
    kill -0 "$server_pid" 2>/dev/null || break
    kill -0 "$agent_pid" 2>/dev/null || break
    sleep 1 &
    wait $!
done

# Collect the one that exited, so its status is this container's status and a
# crash loop is visible in `docker ps` rather than looking like a clean stop.
if kill -0 "$server_pid" 2>/dev/null; then
    gone='mesh agent'
    wait "$agent_pid"
    status=$?
else
    gone='server'
    wait "$server_pid"
    status=$?
fi

echo "node: the $gone exited (status $status); stopping the other half" >&2
stop_both
wait
exit "$status"
