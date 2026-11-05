# Automatic session titles

New standalone sessions start with a placeholder and receive a short title from the first meaningful task you send. Naming is local and deterministic: it uses the first useful line, removes Markdown formatting, and limits the result to 64 Unicode code points. It makes no provider request and adds no model cost.

A name you supply or choose through Rename remains yours, even if it is `Session 1`. Once an automatic title has been assigned, later messages do not replace it. Commands, internal helper results, generated continuations, fenced code and recognizable secrets do not supply titles. Child and group-agent names keep their existing identity rules.

On startup Mingle examines up to 100 older numeric placeholders and uses their earliest eligible recorded task when available. Opening a session is not counted as activity by this backfill. Historic explicitly chosen numeric names without rename evidence cannot be distinguished from old generated names and may be titled; renaming one now records manual ownership and prevents future automatic changes. Empty older sessions remain eligible for a later meaningful request.

This is a concise task label, not an AI summary of the full conversation. You can rename it at any time.
