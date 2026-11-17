--------------------------- MODULE Ownership ---------------------------
\* Lock-file lifecycle of one consumer: lazy acquire, close with unlink, crash, stale sweep, eviction.
\* A step that runs under the global quota lock is one atomic action.
EXTENDS Naturals, FiniteSets
CONSTANTS Procs, MaxInode, UnlinkUnheld, OpenOutsideQuota, KeepLockOnClose, EvictPending
Nobody == "nobody"
Inodes == 1..MaxInode
VARIABLES path, nextInode, holder, opened, owns, data, stale, lost
vars == <<path, nextInode, holder, opened, owns, data, stale, lost>>
\* path: inode of the lock file (0 = no file). holder: OS lock per inode. data: state file content.
\* stale: an unheld lock file left by a crash or by 0.1.1. opened: broken variant only.
Init == /\ path \in {0, 1} /\ nextInode = 2 /\ holder = [i \in Inodes |-> Nobody]
        /\ opened = [p \in Procs |-> 0] /\ owns = {} /\ data = "none"
        /\ stale = (path = 1) /\ lost = FALSE
Held(p) == CHOOSE i \in Inodes : holder[i] = p
\* Opening the path creates a new file when none exists.
CanOpen == path # 0 \/ nextInode <= MaxInode
OpenedInode == IF path # 0 THEN path ELSE nextInode
NextAfterOpen == IF path = 0 THEN nextInode + 1 ELSE nextInode
\* First subscribe, or start with saved state: open plus a non-waiting lock under the quota lock.
\* A busy lock fails closed (no step).
Acquire(p) ==
    /\ ~OpenOutsideQuota /\ p \notin owns /\ CanOpen /\ holder[OpenedInode] = Nobody
    /\ path' = OpenedInode /\ nextInode' = NextAfterOpen
    /\ holder' = [holder EXCEPT ![OpenedInode] = p] /\ owns' = owns \cup {p} /\ stale' = FALSE
    /\ UNCHANGED <<opened, data, lost>>
\* Broken variant: open now, lock later, outside the quota lock.
Open(p) ==
    /\ OpenOutsideQuota /\ p \notin owns /\ opened[p] = 0 /\ CanOpen
    /\ opened' = [opened EXCEPT ![p] = OpenedInode] /\ path' = OpenedInode /\ nextInode' = NextAfterOpen
    /\ UNCHANGED <<holder, owns, data, stale, lost>>
Lock(p) ==
    /\ opened[p] # 0 /\ opened' = [opened EXCEPT ![p] = 0]
    /\ IF holder[opened[p]] = Nobody
       THEN /\ holder' = [holder EXCEPT ![opened[p]] = p] /\ owns' = owns \cup {p}
            /\ stale' = (stale /\ path # opened[p])
       ELSE UNCHANGED <<holder, owns, stale>>
    /\ UNCHANGED <<path, nextInode, data, lost>>
\* The owner saves intents and cursors, accepts pages, or acknowledges them.
Write(p) ==
    /\ p \in owns /\ data' \in {"cursor", "pending"}
    /\ UNCHANGED <<path, nextInode, holder, opened, owns, stale, lost>>
\* Close under the quota lock: unlink the lock file by name, then unlock. Saved state stays.
Close(p) ==
    /\ p \in owns /\ owns' = owns \ {p} /\ holder' = [holder EXCEPT ![Held(p)] = Nobody]
    /\ path' = IF KeepLockOnClose THEN path ELSE 0
    /\ UNCHANGED <<nextInode, opened, data, stale, lost>>
\* Process death releases the OS lock and leaves the lock file.
Crash(p) ==
    /\ p \in owns /\ owns' = owns \ {p} /\ holder' = [holder EXCEPT ![Held(p)] = Nobody]
    /\ stale' = (path # 0)
    /\ UNCHANGED <<path, nextInode, opened, data, lost>>
\* Stale-lock cleanup and slot sweep under the quota lock. Only a lock it can take proves that no
\* live owner exists. It then removes the lock file and may evict cursor-only state, never pages.
Sweep(p) ==
    /\ p \notin owns /\ CanOpen
    /\ holder[OpenedInode] = Nobody \/ (UnlinkUnheld /\ path # 0)
    /\ path' = 0 /\ stale' = FALSE /\ nextInode' = NextAfterOpen
    /\ data' \in {data, IF data = "cursor" \/ (EvictPending /\ data = "pending") THEN "none" ELSE data}
    /\ lost' = (lost \/ (data = "pending" /\ data' = "none"))
    /\ UNCHANGED <<holder, opened, owns>>
Idle == UNCHANGED vars
Next == \/ \E p \in Procs : Acquire(p) \/ Open(p) \/ Lock(p) \/ Write(p) \/ Close(p) \/ Crash(p) \/ Sweep(p)
        \/ Idle
OneOwner == Cardinality(owns) <= 1
PendingKept == ~lost
LockFileMeansOwnerOrCrash == (path # 0 /\ holder[path] = Nobody) => (stale \/ \E p \in Procs : opened[p] = path)
=============================================================================
