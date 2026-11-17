--------------------------- MODULE Delivery ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Consumers, EarlyAck, LateStart, SharedKey, ForgetDirty
VARIABLES accepted, pending, appended, persisted, queued, consumed, owner, phase,
          stopped, streamAfterStop, staged, dirty, failed
vars == <<accepted, pending, appended, persisted, queued, consumed, owner, phase,
          stopped, streamAfterStop, staged, dirty, failed>>
Init == /\ accepted = {} /\ pending = {} /\ appended = {} /\ persisted = {} /\ queued = {}
        /\ consumed = {} /\ owner \in Consumers /\ phase = "connecting"
        /\ stopped = FALSE /\ streamAfterStop = FALSE
        /\ staged = FALSE /\ dirty = FALSE /\ failed = FALSE
AcceptAndSaveOutbox ==
    /\ ~stopped /\ phase = "stream" /\ owner \notin accepted
    /\ accepted' = accepted \cup {owner}
    /\ pending' = pending \cup {owner}
    /\ UNCHANGED <<appended, persisted, queued, consumed, owner, phase, stopped,
                    streamAfterStop, staged, dirty, failed>>
QueuePage ==
    /\ ~stopped /\ owner \in pending /\ owner \notin queued
    /\ queued' = queued \cup {owner}
    /\ UNCHANGED <<accepted, pending, appended, persisted, consumed, owner, phase,
                    stopped, streamAfterStop, staged, dirty, failed>>
MessageEndsBeforeAppend ==
    /\ owner \in queued /\ owner \notin appended /\ EarlyAck
    /\ pending' = pending \ {owner} /\ consumed' = consumed \cup {owner}
    /\ UNCHANGED <<accepted, appended, persisted, queued, owner, phase, stopped,
                    streamAfterStop, staged, dirty, failed>>
AppendTranscript ==
    /\ owner \in queued /\ owner \notin appended
    /\ appended' = appended \cup {owner}
    /\ UNCHANGED <<accepted, pending, persisted, queued, consumed, owner, phase,
                    stopped, streamAfterStop, staged, dirty, failed>>
ReadExactPageAndSyncTranscript ==
    /\ owner \in appended /\ owner \notin persisted
    /\ persisted' = persisted \cup {owner}
    /\ UNCHANGED <<accepted, pending, appended, queued, consumed, owner, phase,
                    stopped, streamAfterStop, staged, dirty, failed>>
ConfirmPersistedPage ==
    /\ owner \in pending \cap persisted
    /\ pending' = pending \ {owner} /\ consumed' = consumed \cup {owner}
    /\ UNCHANGED <<accepted, appended, persisted, queued, owner, phase, stopped,
                    streamAfterStop, staged, dirty, failed>>
ConnectionReturns ==
    /\ phase = "connecting" /\ (~stopped \/ LateStart)
    /\ phase' = "mode"
    /\ UNCHANGED <<accepted, pending, appended, persisted, queued, consumed, owner,
                    stopped, streamAfterStop, staged, dirty, failed>>
ModeReturnsAndStreamStarts ==
    /\ phase = "mode" /\ (~stopped \/ LateStart)
    /\ phase' = "stream" /\ streamAfterStop' = stopped
    /\ UNCHANGED <<accepted, pending, appended, persisted, queued, consumed, owner,
                    stopped, staged, dirty, failed>>
Unsubscribe ==
    /\ ~stopped /\ stopped' = TRUE
    /\ UNCHANGED <<accepted, pending, appended, persisted, queued, consumed, owner,
                    phase, streamAfterStop, staged, dirty, failed>>
CrashAndResume ==
    /\ queued' = {} /\ stopped' = FALSE /\ phase' = "connecting"
    /\ owner' \in Consumers /\ appended' = persisted
    /\ staged' = FALSE /\ dirty' = FALSE /\ failed' = FALSE
    /\ UNCHANGED <<accepted, pending, persisted, consumed, streamAfterStop>>
ReuseAnotherConsumersKey ==
    /\ SharedKey /\ owner \notin accepted /\ accepted # {}
    /\ accepted' = accepted \cup {owner}
    /\ UNCHANGED <<pending, appended, persisted, queued, consumed, owner, phase,
                    stopped, streamAfterStop, staged, dirty, failed>>
StageWrite ==
    /\ ~staged /\ staged' = TRUE /\ dirty' = TRUE
    /\ UNCHANGED <<accepted, pending, appended, persisted, queued, consumed, owner,
                    phase, stopped, streamAfterStop, failed>>
FlushFails ==
    /\ staged /\ dirty /\ ~failed /\ failed' = TRUE
    /\ dirty' = ~ForgetDirty
    /\ UNCHANGED <<accepted, pending, appended, persisted, queued, consumed, owner,
                    phase, stopped, streamAfterStop, staged>>
FlushSucceeds ==
    /\ staged /\ dirty /\ staged' = FALSE /\ dirty' = FALSE /\ failed' = FALSE
    /\ UNCHANGED <<accepted, pending, appended, persisted, queued, consumed, owner,
                    phase, stopped, streamAfterStop>>
Idle == UNCHANGED vars
Next == AcceptAndSaveOutbox \/ QueuePage \/ MessageEndsBeforeAppend \/ AppendTranscript
     \/ ReadExactPageAndSyncTranscript \/ ConfirmPersistedPage \/ ConnectionReturns
     \/ ModeReturnsAndStreamStarts \/ Unsubscribe \/ CrashAndResume
     \/ ReuseAnotherConsumersKey \/ StageWrite \/ FlushFails \/ FlushSucceeds \/ Idle
AcceptedIsRecoverable == accepted \subseteq pending \cup persisted
ConsumedIsPersisted == consumed \subseteq persisted
StopFencesStartup == ~streamAfterStop
FailedFlushIsRetryable == (staged /\ failed) => dirty
=============================================================================
