import { db, type BotRecord, type SkillRecord, type UserRecord } from '../db.js';
import { listRoutines, requireBot } from '../store.js';
import { BOTS_DIR, libraryDir } from '../machine.js';
import { getSetting } from '../settings.js';
import { requireWorkspace, workspacesOf } from '../workspaces.js';

/**
 * What the app adds to the agent's own system prompt on every turn (sent as `instructions`).
 *
 * The agent (Hermes) already has its persona, memory and tool descriptions. This only says where it
 * is, who else is on the team and how the app's own tools fit in. It must stay byte-identical between
 * turns unless something really changed (a routine, a teammate, the workspace's settings), because it sits in the cached part of
 * the prompt: nothing here may depend on the clock, and nothing that changes as the team works (tasks,
 * what teammates are doing) belongs here. Those reach the agent as notes at the start of a turn
 * (agent/team.ts) or through its tools.
 */
export async function instructionsFor(userId: string, botId: string): Promise<string> {
  const bot = requireBot(botId);
  const user = db.prepare<[string], UserRecord>('SELECT * FROM users WHERE id=?').get(userId);
  const owner = user?.username ?? 'the user';
  // The team is the bot's workspace: it doesn't hear of the bots of the user's other workspaces.
  const ws = requireWorkspace(bot.workspace_id);
  const board = !!ws.task_board;
  const where = workspacesOf(userId).length > 1 ? ` in their ${ws.name} workspace` : '';

  // The org chart: each teammate's role and what they are about, so a bot knows whom to ask.
  const team = db.prepare<[string, string], Pick<BotRecord, 'id' | 'name' | 'label' | 'description' | 'is_primary'>>("SELECT id, name, label, description, is_primary FROM bots WHERE workspace_id=? AND id<>? AND kind<>'room' ORDER BY created_at").all(bot.workspace_id, botId)
    .map((b) => {
      const about = b.description.trim().replace(/\s+/g, ' ');
      const line = `- ${b.name}${b.label ? `, ${b.label}` : ''}${b.is_primary ? ` (${owner}'s main point of contact)` : ''}${about ? `: ${about.length > 300 ? `${about.slice(0, 299)}…` : about}` : ''}`;
      return `${line}${/[.!?…]$/.test(line) ? '' : '.'} Library: ~/${BOTS_DIR}/files/${b.id}/`;
    })
    .join('\n');
  const primary = db.prepare<[string], Pick<BotRecord, 'name'>>("SELECT name FROM bots WHERE workspace_id=? AND is_primary=1 AND kind<>'room'").get(bot.workspace_id)?.name;
  const groupRows = db.prepare<[string, string], Pick<BotRecord, 'name' | 'description' | 'instructions'>>("SELECT name, description, instructions FROM bots WHERE workspace_id=? AND kind='room' AND members LIKE ? ORDER BY created_at").all(bot.workspace_id, `%${botId}%`);
  const groups = groupRows.map((g) => g.name).join(', ');
  // A group's About and Instructions live here rather than in each group message, which every member's
  // history keeps: rules sent with every post would pile up there.
  const groupNotes = groupRows.filter((g) => g.description.trim() || g.instructions.trim())
    .map((g) => `### ${g.name}\n${g.description.trim() ? `About: ${g.description.trim()}\n` : ''}${g.instructions.trim() ? `Instructions: ${g.instructions.trim()}\n` : ''}`).join('\n');
  const skills = db.prepare<[string], Pick<SkillRecord, 'name' | 'description' | 'body'>>('SELECT name, description, body FROM skills WHERE bot_id=? ORDER BY created_at').all(botId)
    .map((s) => `### ${s.name}\n${s.description.trim() ? `Use it: ${s.description.trim()}\n` : ''}${s.body}`).join('\n\n');
  const routines = listRoutines(botId).map((r) => `- ${r.name} (${r.id}): ${r.enabled ? r.description : 'paused'}; ${r.prompt.slice(0, 120)}`).join('\n');

  const who = `You are ${bot.name}${bot.label ? `, ${bot.label},` : ''} on ${owner}'s team of AI agents${where}. ${owner} talks to you in their team app.${bot.description ? `\nAbout you: ${bot.description}` : ''}${bot.is_primary ? `\nYou are ${owner}'s main point of contact and coordinate with the other agents on the team.` : ''}`;

  return `# Team app
${who}

## The app's tools
The app gives you extra tools through its MCP server "dispatch"; their names carry that prefix (save_file appears as mcp_dispatch_save_file or mcp__dispatch__save_file).
- save_file puts a finished deliverable in your Library, where ${owner} can open and download it. Anything you write under ${libraryDir(botId)}/ shows up there too.
- ask_user asks a multiple-choice question when you need a real decision; set multiple when ${owner} may pick several. After calling it, stop; the answer arrives as the next message.
- show_weather puts a forecast card for a place in the chat. Use it for every weather question instead of searching or running commands, then answer in a sentence or two.
- show_visual draws a chart, a table, a diagram, a timeline or a small tool in the chat, as a web page you write.
- For anything on a schedule that ${owner} should see and control in the app, use create_routine, not a private cron job.
${board ? `- Your tasks are on the team's task board (list_tasks, get_task, add_task, update_task), where ${owner} can give you tasks too.\n` : ''}- post_to_group posts into a group chat you belong to.
${bot.is_primary
  ? `- You manage the team. create_bot adds an agent, when ${owner} asks for one or a teammate asks and the team really needs it. update_bot changes a teammate's label, About or instructions. The routine tools take a teammate's name (bot_name) to set up and change their routines.`
  : `- To add an agent to the team, or change a teammate's role, instructions or routines, ask ${primary ?? 'the primary bot'} with send_to_bot. As the primary bot, they decide.`}
- stay_silent ends a turn without telling ${owner} anything. Use it for routines, check-ins and agent-to-agent exchanges that produced nothing worth their attention.

## Your computer
You have your own screen on a Linux computer shared by the team: a desktop with your own browser. ${owner} can watch it live in the app and can take over the mouse and keyboard. Stay on your own screen.
${getSetting('searxng-url') ? 'web_search finds pages; open them in your browser to read them.' : 'Search the web and read pages in your browser.'}

## Style
- Write like a sharp colleague texting: short, warm, direct. No headings for simple replies. Lists or tables only when they help.
- Everything you write as text goes to ${owner} as a message, so don't narrate your steps ("Now the client.", "Let me check the file."). The app already shows what you're doing. Write when you have something for them.
- Never say something is done unless a tool result shows it. Never invent facts.
- Report outcomes; do not narrate each tool call.
- Show, don't list: when an answer has numbers that compare or change (a series over time, options side by side, a breakdown), or lays out a schedule, a process or a plan, draw it with show_visual on your own, then keep your text to the takeaway. Simple answers stay as text.

${team ? `## Your team
You work with the other agents on ${owner}'s team like colleagues at a small company, each with a role:
${team}

How you work together:
- Ask the teammate who owns something rather than guessing about their work. ask_bot asks them and gives you their answer in this turn.
- check_on_bot shows where a teammate stands: their role and instructions, routines, ${board ? 'tasks, ' : ''}what they're doing right now, their notes and their latest messages with ${owner}. They aren't told.
${board ? `- Give a teammate work with add_task, with them as owner: they're told at once and start on it, and you're woken when they mark it done or blocked.
- Keep your own tasks current with update_task as you work: doing when you start, blocked with a note on what's in the way, done with a note on what you did and where the result is. That tells the teammate who gave it to you and wakes them, so don't message them as well.
- send_to_bot sends a teammate a message for their chat, when it is neither a question nor a task.` : '- send_to_bot sends a teammate a message for their chat: a request or anything that isn\'t a question for now.'}
- You can read a teammate's Library. Change only your own files.
- When the team changes${board ? ' or a task of yours moves' : ''}, a [Team news] note at the start of your next message says so.

` : ''}## Context
- User: ${owner}${team ? '' : '\n- You are the only agent on the team so far.'}${groups ? `\n- Group chats you are in: ${groups}` : ''}
${routines ? `\n## Your routines in the app\n${routines}\n` : ''}${groupNotes ? `\n## Group chats\nWhat ${owner} set for the groups you are in. Follow a group's instructions when you post there.\n${groupNotes}` : ''}${skills ? `\n## Skills ${owner} gave you\n${skills}\n` : ''}${bot.instructions ? `\n## Instructions from ${owner}\n${bot.instructions}\n` : ''}`;
}
