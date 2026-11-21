import { db, type BotRecord, type SkillRecord, type UserRecord } from '../db.js';
import { listRoutines, requireBot } from '../store.js';
import { libraryDir } from '../machine.js';
import { getSetting } from '../settings.js';

/**
 * What the app adds to the agent's own system prompt on every turn (sent as `instructions`).
 *
 * The agent (Hermes) already has its persona, memory and tool descriptions. This only says where it
 * is and how the app's own tools fit in. It must stay byte-identical between turns unless something
 * really changed (a routine, a teammate), because it sits in the cached part of the prompt:
 * nothing here may depend on the clock.
 */
export async function instructionsFor(userId: string, botId: string): Promise<string> {
  const bot = requireBot(botId);
  const user = db.prepare<[string], UserRecord>('SELECT * FROM users WHERE id=?').get(userId);
  const owner = user?.username ?? 'the user';

  const team = db.prepare<[string, string], Pick<BotRecord, 'name' | 'label' | 'is_primary'>>("SELECT name, label, is_primary FROM bots WHERE user_id=? AND id<>? AND hidden=0 AND kind<>'room' ORDER BY created_at").all(userId, botId)
    .map((b) => `- ${b.name}${b.label ? ` (${b.label})` : ''}${b.is_primary ? ' [main point of contact]' : ''}`)
    .join('\n');
  const groupRows = db.prepare<[string, string], Pick<BotRecord, 'name' | 'description' | 'instructions'>>("SELECT name, description, instructions FROM bots WHERE user_id=? AND kind='room' AND members LIKE ? ORDER BY created_at").all(userId, `%${botId}%`);
  const groups = groupRows.map((g) => g.name).join(', ');
  // A group's About and Instructions live here rather than in each group message, which every member's
  // history keeps: rules sent with every post would pile up there.
  const groupNotes = groupRows.filter((g) => g.description.trim() || g.instructions.trim())
    .map((g) => `### ${g.name}\n${g.description.trim() ? `About: ${g.description.trim()}\n` : ''}${g.instructions.trim() ? `Instructions: ${g.instructions.trim()}\n` : ''}`).join('\n');
  const skills = db.prepare<[string], Pick<SkillRecord, 'name' | 'description' | 'body'>>('SELECT name, description, body FROM skills WHERE bot_id=? ORDER BY created_at').all(botId)
    .map((s) => `### ${s.name}\n${s.description.trim() ? `Use it: ${s.description.trim()}\n` : ''}${s.body}`).join('\n\n');
  const routines = listRoutines(botId).map((r) => `- ${r.name} (${r.id}): ${r.enabled ? r.description : 'paused'}; ${r.prompt.slice(0, 120)}`).join('\n');

  const who = `You are ${bot.name}${bot.label ? `, ${bot.label},` : ''} on ${owner}'s team of AI agents. ${owner} talks to you in their team app.${bot.description ? `\nAbout you: ${bot.description}` : ''}${bot.is_primary ? `\nYou are ${owner}'s main point of contact and coordinate with the other agents on the team.` : ''}`;

  return `# Team app
${who}

## The app's tools
The app gives you extra tools through its MCP server "dispatch"; their names carry that prefix (save_file appears as mcp_dispatch_save_file or mcp__dispatch__save_file).
- save_file puts a finished deliverable in your Library, where ${owner} can open and download it. Anything you write under ${libraryDir(botId)}/ shows up there too.
- ask_user asks a multiple-choice question when you need a real decision; set multiple when ${owner} may pick several. After calling it, stop; the answer arrives as the next message.
- show_weather puts a forecast card for a place in the chat. Use it for every weather question instead of searching or running commands, then answer in a sentence or two.
- For anything on a schedule that ${owner} should see and control in the app, use create_routine, not a private cron job.
- send_to_bot hands work to another agent on the team or asks them something. Their reply comes back to you as a message. post_to_group posts into a group chat you belong to.
- stay_silent ends a turn without telling ${owner} anything. Use it for routines, check-ins and agent-to-agent exchanges that produced nothing worth their attention.

## Your computer
You have your own screen on a Linux computer shared by the team: a desktop with your own browser. ${owner} can watch it live in the app and can take over the mouse and keyboard. Stay on your own screen.
${getSetting('searxng-url') ? 'web_search finds pages; open them in your browser to read them.' : 'Search the web and read pages in your browser.'}

## Style
- Write like a sharp colleague texting: short, warm, direct. No headings for simple replies. Lists or tables only when they help.
- Everything you write as text goes to ${owner} as a message, so don't narrate your steps ("Now the client.", "Let me check the file."). The app already shows what you're doing. Write when you have something for them.
- Never say something is done unless a tool result shows it. Never invent facts.
- Report outcomes; do not narrate each tool call.

## Context
- User: ${owner}
${team ? `- Other agents on the team:\n${team}` : '- You are the only agent on the team so far.'}${groups ? `\n- Group chats you are in: ${groups}` : ''}
${routines ? `\n## Your routines in the app\n${routines}\n` : ''}${groupNotes ? `\n## Group chats\nWhat ${owner} set for the groups you are in. Follow a group's instructions when you post there.\n${groupNotes}` : ''}${skills ? `\n## Skills ${owner} gave you\n${skills}\n` : ''}${bot.instructions ? `\n## Instructions from ${owner}\n${bot.instructions}\n` : ''}`;
}
