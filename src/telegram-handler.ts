import { sendMessage } from './telegram.js';
import { editMenu, btn } from './ui-engine.js';

// ─── Dynamic module loaders ────────────────────────────────────────

async function getSupabase() {
  const mod = await import('./supabase.js');
  const fn = (mod as any).getSupabaseClient || (mod as any).getClient ||
    (mod as any).createClient || (mod as any).supabase || (mod as any).default;
  return typeof fn === 'function' ? fn() : fn;
}

// ─── Main Entry ─────────────────────────────────────────────────────

export async function handleUpdate(update: any): Promise<void> {
  // Handle callback queries (buttons)
  if (update.callback_query) {
    try {
      const cbMod = await import('./callback-handler.js');
      const handler = (cbMod as any).handleCallback || (cbMod as any).default;
      if (typeof handler === 'function') await handler(update);
    } catch (err: any) {
      console.error('❌ Callback handler error:', err.message);
    }
    return;
  }

  // Handle messages
  const message = update.message;
  if (!message) return;

  const chatId: number = message.chat?.id;
  const text: string = (message.text || '').trim();
  const from = message.from;
  const userId: number = from?.id || chatId;

  if (!chatId || !text) return;

  // Dedup: ignore messages older than 60s
  const msgDate = message.date || 0;
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - msgDate > 60) return;

  try {
    // ── Check for active sessions (newsite, etc.) ────────────────
    if (!text.startsWith('/')) {
      try {
        const sb = await getSupabase();
        const { data: session } = await sb
          .from('bot_sessions')
          .select('*')
          .eq('chat_id', chatId)
          .eq('user_id', userId)
          .single();

        if (session && (session as any).workflow === 'newsite') {
          await sb.from('bot_sessions')
            .delete()
            .eq('chat_id', chatId)
            .eq('user_id', userId);

          await sendMessage(chatId,
            '🏗 *Building your site…*\n\nThis takes 1-2 minutes.\n' +
            '1. Generating HTML with AI\n2. Creating GitHub repo\n3. Deploying to Netlify'
          );

          try {
            const sbMod = await import('./site-builder.js');
            const buildFn = (sbMod as any).buildSite || (sbMod as any).createSite || (sbMod as any).default;
            if (typeof buildFn === 'function') {
              const result = await buildFn(text, userId);
              await sendMessage(chatId,
                `✅ *Site created!*\n\n` +
                `🌐 URL: ${result?.url || 'check Netlify'}\n` +
                `📂 Repo: ${result?.repo || 'check GitHub'}\n` +
                `🚀 Deploy: ${result?.deployUrl || 'check Netlify dashboard'}`
              );
            } else {
              await sendMessage(chatId, '⚠️ Site builder loaded but no build function found.');
            }
          } catch (err: any) {
            await sendMessage(chatId, `❌ Site build failed: ${err.message}`);
          }
          return;
        }
      } catch {
        // Session check failed, continue with normal routing
      }
    }

    // ── Command routing ──────────────────────────────────────────
    if (!text.startsWith('/')) {
      await sendMessage(chatId, '🤖 Send /start to see the menu.');
      return;
    }

    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase().split('@')[0]; // strip @botname
    const cmdArgs = parts.slice(1).join(' ');

    // Dev commands → delegate to dev-commands module
    const devCmds = ['/repos', '/browse', '/readfile', '/analyze', '/fix',
      '/watch', '/newsite', '/netlify', '/deploy', '/ci', '/devstatus'];

    if (devCmds.includes(cmd)) {
      try {
        const devMod = await import('./dev-commands.js');
        const handler = (devMod as any).handleDevCommand || (devMod as any).handleCommand || (devMod as any).default;
        if (typeof handler === 'function') {
          await handler(chatId, text, from, cmd, cmdArgs);
        } else {
          await sendMessage(chatId, '⚠️ Dev commands module not available.');
        }
      } catch (err: any) {
        await sendMessage(chatId, `❌ Dev command error: ${err.message}`);
      }
      return;
    }

    // ── Built-in commands ────────────────────────────────────────
    switch (cmd) {
      case '/start': {
        await editMenu(chatId, 0, '🤖 *XTOP Career Agent*', [
          [btn('💼 Jobs', 'm:jobs'), btn('📊 CRM', 'm:crm')],
          [btn('📧 Outreach', 'm:outreach'), btn('🛠 Dev Tools', 'm:dev')],
          [btn('🚀 Deploy', 'dp:menu'), btn('🏗 Infra', 'm:infra')],
          [btn('📋 Tasks', 'm:tasks'), btn('📈 Status', 'm:status')],
        ]);
        break;
      }

      case '/status': {
        const sb = await getSupabase();
        const { count: taskCount } = await sb.from('tasks').select('id', { count: 'exact', head: true });
        const { count: leadCount } = await sb.from('job_leads').select('id', { count: 'exact', head: true });
        const { count: prospectCount } = await sb.from('prospects').select('id', { count: 'exact', head: true });
        await sendMessage(chatId,
          `📈 *Status Report*\n\n` +
          `📋 Tasks: ${taskCount || 0}\n` +
          `💼 Leads: ${leadCount || 0}\n` +
          `👥 Prospects: ${prospectCount || 0}\n` +
          `🐙 GitHub: ${process.env.GITHUB_TOKEN ? '✅' : '❌'}\n` +
          `▲ Render: ${process.env.RENDER_API_KEY ? '✅' : '❌'}\n` +
          `🌐 Netlify: ${process.env.NETLIFY_AUTH_TOKEN ? '✅' : '❌'}`
        );
        break;
      }

      case '/tasks': {
        const sb = await getSupabase();
        const { data: tasks } = await sb
          .from('tasks')
          .select('id, type, status, created_at')
          .order('created_at', { ascending: false })
          .limit(10);
        const list = (tasks as any[]) || [];
        if (list.length === 0) {
          await sendMessage(chatId, '📋 No tasks yet.');
        } else {
          const text = '📋 *Recent Tasks*\n\n' + list.map((t: any) =>
            `${t.status === 'done' ? '✅' : '🔄'} ${t.type} — ${t.status}\n_${t.created_at}_`
          ).join('\n\n');
          await sendMessage(chatId, text);
        }
        break;
      }

      case '/discover': {
        await sendMessage(chatId, '🔍 *Discovering jobs…*\n\nThis may take a moment.');
        try {
          const jobMod = await import('./job-discovery.js');
          const discover = (jobMod as any).discoverJobs || (jobMod as any).runDiscovery || (jobMod as any).default;
          if (typeof discover === 'function') {
            const result = await discover();
            await sendMessage(chatId, `✅ Discovery complete.\n${result || 'Check /report for results.'}`);
          } else {
            await sendMessage(chatId, '⚠️ Job discovery module not available.');
          }
        } catch (err: any) {
          await sendMessage(chatId, `❌ Discovery failed: ${err.message}`);
        }
        break;
      }

      case '/report': {
        const sb = await getSupabase();
        const { data: leads } = await sb
          .from('job_leads')
          .select('title, company, url, created_at')
          .order('created_at', { ascending: false })
          .limit(5);
        const list = (leads as any[]) || [];
        if (list.length === 0) {
          await sendMessage(chatId, '📊 No leads yet. Run /discover first.');
        } else {
          const text = '📊 *Latest Leads*\n\n' + list.map((l: any) =>
            `💼 *${l.title}*\n${l.company}\n${l.url || '—'}\n_${l.created_at}_`
          ).join('\n\n');
          await sendMessage(chatId, text);
        }
        break;
      }

      case '/infra': {
        await sendMessage(chatId,
          `🏗 *Infrastructure*\n\n` +
          `🐙 GitHub: ${process.env.GITHUB_TOKEN ? '✅' : '❌'}\n` +
          `▲ Render: ${process.env.RENDER_API_KEY ? '✅' : '❌'}\n` +
          `🗄 Supabase: ✅\n` +
          `🌐 Netlify: ${process.env.NETLIFY_AUTH_TOKEN ? '✅' : '❌'}`
        );
        break;
      }

      case '/github': {
        const ok = !!process.env.GITHUB_TOKEN;
        await sendMessage(chatId, `🐙 *GitHub*\n\nStatus: ${ok ? '✅ Connected' : '❌ Not configured'}`);
        break;
      }

      case '/render': {
        const ok = !!process.env.RENDER_API_KEY;
        await sendMessage(chatId, `▲ *Render*\n\nStatus: ${ok ? '✅ Connected' : '❌ Not configured'}`);
        break;
      }

      case '/dbstatus': {
        try {
          const sb = await getSupabase();
          const { error } = await sb.from('tasks').select('id').limit(1);
          await sendMessage(chatId, `🗄 *Supabase*: ${error ? '❌ ' + error.message : '✅ Connected'}`);
        } catch (e: any) {
          await sendMessage(chatId, `🗄 *Supabase*: ❌ ${e.message}`);
        }
        break;
      }

      case '/crm':
      case '/prospects': {
        const sb = await getSupabase();
        const { data } = await sb
          .from('prospects')
          .select('name, company, status')
          .order('created_at', { ascending: false })
          .limit(10);
        const list = (data as any[]) || [];
        if (list.length === 0) {
          await sendMessage(chatId, '👥 No prospects. Use /addprospect to add.');
        } else {
          const text = '👥 *Prospects*\n\n' + list.map((p: any) =>
            `${p.status === 'won' ? '🎉' : '🆕'} *${p.name}* — ${p.company || '—'} (${p.status})`
          ).join('\n');
          await sendMessage(chatId, text);
        }
        break;
      }

      case '/addprospect': {
        if (!cmdArgs) {
          await sendMessage(chatId, 'Usage: /addprospect Name | Company | Email');
          break;
        }
        const [name, company, email] = cmdArgs.split('|').map(s => s.trim());
        if (!name) {
          await sendMessage(chatId, '❌ Name is required.');
          break;
        }
        const sb = await getSupabase();
        await sb.from('prospects').insert({ name, company: company || null, email: email || null, status: 'new' });
        await sendMessage(chatId, `✅ Added prospect: *${name}*`);
        break;
      }

      case '/draft': {
        if (!cmdArgs) {
          await sendMessage(chatId, 'Usage: /draft prospect_name');
          break;
        }
        await sendMessage(chatId, `📝 *Drafting outreach for ${cmdArgs}…*\n\nThis may take a moment.`);
        try {
          const outMod = await import('./outreach-engine.js');
          const draft = (outMod as any).draftEmail || (outMod as any).createDraft || (outMod as any).default;
          if (typeof draft === 'function') {
            const result = await draft(cmdArgs);
            await sendMessage(chatId, `📝 *Draft:*\n\n${result || 'Draft created.'}`);
          } else {
            await sendMessage(chatId, '⚠️ Outreach module not available.');
          }
        } catch (err: any) {
          await sendMessage(chatId, `❌ Draft failed: ${err.message}`);
        }
        break;
      }

      case '/outreach': {
        const sb = await getSupabase();
        const { data } = await sb
          .from('outreach')
          .select('prospect_name, status, created_at')
          .order('created_at', { ascending: false })
          .limit(10);
        const list = (data as any[]) || [];
        if (list.length === 0) {
          await sendMessage(chatId, '📧 No outreach records.');
        } else {
          const text = '📧 *Outreach*\n\n' + list.map((o: any) =>
            `${o.status === 'sent' ? '📤' : '📝'} ${o.prospect_name} — ${o.status}\n_${o.created_at}_`
          ).join('\n\n');
          await sendMessage(chatId, text);
        }
        break;
      }

      case '/send': {
        await sendMessage(chatId, '📤 Use /outreach to see drafts, then /approve to send.');
        break;
      }

      case '/approve': {
        await sendMessage(chatId, '✅ Approval flow: use the buttons in /outreach to approve drafts.');
        break;
      }

      case '/reject': {
        await sendMessage(chatId, '❌ Rejection flow: use the buttons in /outreach to reject drafts.');
        break;
      }

      default:
        await sendMessage(chatId, `❓ Unknown command: ${cmd}\n\nSend /start to see the menu.`);
    }
  } catch (err: any) {
    console.error('❌ Handler error:', err.message);
    await sendMessage(chatId, `❌ Error: ${err.message}`).catch(() => {});
  }
}
