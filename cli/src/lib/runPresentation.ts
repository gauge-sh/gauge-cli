import { SMALL_DOG_LOGO } from "./logo";

export const RUN_LOGO_BLOCK = `\`\`\`text
${SMALL_DOG_LOGO}
\`\`\``;

export const RUN_LAYOUT_INSTRUCTIONS = `Show the exact dog artwork below with a clickable "Watch running sessions" link immediately to its right, aligned with the dog's middle row. Preserve the artwork's characters and spacing. Wrap each artwork row in inline code and separate rows with Markdown hard line breaks (two trailing spaces); put the Markdown link outside the middle row's inline code so it stays clickable. The fenced block is reference artwork, not the final side-by-side layout. Do not redraw, abbreviate, or substitute the dog. Show this small dog once per actual launch, including reruns.`;

export const RUN_PRESENTATION_REMINDER = `Agents: the user cannot see this CLI output. In your launch update, show the session summary first. ${RUN_LAYOUT_INSTRUCTIONS} Run \`gauge watch\` with the same backend and organization as the launch to get the exact URL. Report the actual launch state. If already shown for this launch, do not repeat the card. If you omitted it, include it in your next update while sessions are still running, without asking the user whether to read more instructions.
${RUN_LOGO_BLOCK}`;
