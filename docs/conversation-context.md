# Conversation context and composer controls

The small ring beside Send shows the latest context reading for this conversation. It turns yellow above 70% and red above 90%. Hover over it, or activate it with the keyboard, to see the percentage, token count and report time. A dashed ring means the provider has not reported enough information; it does not mean the conversation is empty. Codex and Claude estimates are labelled.

**Compact conversation** asks the selected provider to compact its native history. It preserves your unsent draft and attachments. The action is unavailable during a run or cleanup, before native history exists, for remote-owner conversations, and for unsupported providers. You can request cancellation while it runs. Completion clears the old reading and retains a fresh report if the native provider emits one after its compaction boundary. Otherwise the ring waits for the next provider report; it does not display an invented 0%. The provider decides what its summary retains.

**Auto-compact at** saves a threshold from 1% to 100% for this conversation. Clear the field and select **Save** to turn it off. When a supported provider reports a reading at or above the threshold during a dispatched turn, Mingle pauses that turn, waits for the provider to stop, and saves a recovery checkpoint before compacting. After success, Mingle continues the same run using the compacted native history. Other conversations can keep working. A turn can auto-compact once, and a failed or cancelled compaction stops the run. Native provider compaction can still happen independently.

For a group, select or address one agent to see that agent's ring and compact its history. Multiple recipients have no combined context percentage.

## Write the request instead of choosing a mode

- Ordinary questions and coding requests use normal conversation turns.
- “Plan the migration”, “Please create a plan…” or `/plan …` requests a native read-only plan. Review and approve the result before execution. Group plans require one recipient.
- “Keep working until…” or “Work autonomously…” starts a bounded standalone goal. The defaults are eight turns, four hours and two stall observations; Advanced conversation settings exposes the limits. Pause, Stop and Resume remain visible while a goal exists. A paused goal must be resumed or stopped before starting another.

The routing uses explicit leading directives, not background model calls. Ambiguous wording stays in normal chat. Provider commands, skill invocations and quoted code are not treated as instructions to start autonomy. Existing provider permissions remain in force.

Agents can ask focused questions whenever they need more context, including during ordinary chat. Questions appear in the composer activity area and wait for your answer. There is no need to choose Plan first.

The model control now sizes to its label with a compact maximum width. Its popup retains room for model names and search, opens from the corresponding edge of the control and respects reduced-motion preferences.

When an app has a web version, Mingle instructs agents with browser access to use the built-in browser to test the affected behavior. Browser tabs opened by an agent use a floating surface and leave the sidebar closed unless you choose to open or dock it.
