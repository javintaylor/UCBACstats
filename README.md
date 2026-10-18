# UCBACstats source mirror

Sanitized source-only mirror refreshed October 18, 2026 using existing authorized read-only clasp access. Apps Script is the source authority; GitHub does not host or deploy the live portal.

Fresh deployment metadata independently verified the live website as version 238. Separate current-editor and immutable-v238 captures each contain 63 files and were byte-identical. The mirror includes 58 files from each capture; five record-bound one-off utilities are deliberately omitted under owner approval because they embed private player records:

- PlayerMerge20261015.js
- PlayerMergeSecond20261015.js
- PlayerMergeThird20261015.js
- MergeActivation20261015.js
- BohemiaReview20261017.js

Original private captures are preserved locally. Omission is a privacy coverage limit, not deletion from Apps Script or a claim that those tools do not exist. Root source and manifest.json represent the sanitized editor files. source-mirror.zip contains src/, snapshots/v238/, the prior immutable snapshots/v221/ and tools/. SOURCE-SNAPSHOT.txt is a text companion of the sanitized editor files.

Historical contact and player correction/merge arrays in retained source are emptied, operational resource/contact/deployment literals replaced, and personal-record commentary removed. No script-property values, credentials, account/player exports or private captured files are included. This is not deployable production configuration; omitted utilities and placeholders prevent treating it as a complete runtime clone. Google Sites content/configuration is outside capture scope.

Manual workflow: capture fresh editor and separately verified deployment into new private directories; apply reviewed sanitization and explicit exclusions; review every diff and inventory; verify manifest hashes and offline syntax; publish through a reviewed branch/PR; re-read exact remote bytes and deliver a bounded factual checkpoint to Claude UCBACstats Canonical. Updates are manual, not automatic synchronization.

No Apps Script push, version creation, deployment, operational function, hosted test or production data change is part of source refresh. See UPDATE-WORKFLOW.txt.
