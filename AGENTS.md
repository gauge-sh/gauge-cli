# Public publication review

This repository and its PRs are public. Before pushing commits or publishing or
editing PRs, comments, issues, releases, or attachments, perform a holistic review
of the exact material that will become public. This is a contextual review, not
a keyword scan or a private-link check.

1. Confirm the destination and intended audience. Identify which source context
   came from private repositories, conversations, systems, or customer data.
   Authorization to publish a feature does not automatically authorize publishing
   that surrounding private context.
2. Inspect all outgoing content: source and comments, tests and fixtures,
   generated files, documentation, filenames, screenshots and other assets,
   commit messages, and the exact proposed PR title/body or other public text.
   Inspect every outgoing commit, not only the final diff: deleting sensitive
   material in a later commit still publishes it in history.
3. Ask whether each detail belongs in the public artifact and is necessary for
   its audience. Check for credentials, customer or personal data, internal
   architecture and operational details, account identifiers, local paths,
   private links or issue references, unreleased plans, and internal discussion
   or test artifacts. Newly implemented public functionality is expected; private
   context that happened to inform it is not automatically part of that scope.
4. Rewrite public explanations so they stand on their own. Describe required
   behavior or interfaces without referring readers to private implementation
   work. Verify doubtful references are publicly accessible; your own access is
   not evidence of public availability. Remove unnecessary uncertain details.
5. Have a separate agent review the publication boundary when available. Give it
   the relevant private context and the exact outgoing artifacts, and ask for
   disclosure findings rather than only code correctness. Keep its report
   private if the rationale contains private information. Resolve findings
   before publication; a scanner or passing tests do not replace this review.
6. Tie the review to the actual outgoing commits and exact public text. Publish
   only what was reviewed; review subsequent changes before publishing them.
   Prepare PR text in a local file and use `--body-file` to preserve the reviewed
   content. Summarize the review scope and result in the working conversation.

This review does not require another user approval for already authorized,
clearly public work. Ask only when a material disclosure decision remains
unresolved and the task cannot be completed by omitting the questionable detail.
