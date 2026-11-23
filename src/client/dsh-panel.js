/**
 * Desktop settings panel for agent-sandbox-runtime.
 *
 * Runs are ungoverned by default: conversations are never stopped by the
 * runtime policy, deadline or budget until the user explicitly governs one
 * here. The panel only talks to the host API under /agent-sandbox-runtime/api.
 */
window.__ModuleLoader__.load({
  id: 'agent-sandbox-runtime',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const API = '/agent-sandbox-runtime/api';

    async function call(path, body) {
      const response = await fetch(API + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-agent-sandbox-runtime-request': '1', 'content-type': 'application/json' },
        cache: 'no-store',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok || value.ok === false) throw new Error(value.error || `HTTP ${response.status}`);
      return value;
    }

    const styles = `
.agr-page{font-family:ui-monospace,monospace;font-size:12px;line-height:1.6;padding:14px 16px;max-width:780px}
.agr-page h3{margin:0 0 8px;font-size:13px}
.agr-hint{color:var(--theme-text-secondary,#888);font-size:11px;margin:0 0 10px}
.agr-list{list-style:none;margin:0;padding:0}
.agr-item{border:1px solid var(--theme-border,#333);border-radius:8px;padding:10px 12px;margin-bottom:8px}
.agr-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.agr-task{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agr-badge{font-size:10px;padding:2px 8px;border-radius:10px;white-space:nowrap}
.agr-badge.off{background:rgba(46,204,113,.15);color:#2ecc71}
.agr-badge.on{background:rgba(231,76,60,.15);color:#e74c3c}
.agr-meta{color:var(--theme-text-secondary,#888);font-size:11px;margin:0 0 8px}
.agr-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px}
.agr-btn.ghost{background:transparent;border:1px solid var(--theme-border,#444);color:var(--theme-text,#ccc)}
.agr-btn:disabled{opacity:.45;cursor:not-allowed}
.agr-msg{margin-top:10px;padding:8px 10px;border-radius:6px;background:var(--theme-input-bg,#111);border:1px solid var(--theme-border,#333);white-space:pre-wrap;font-size:11px}
`;

    function formatDeadline(deadline, governed) {
      if (!governed) return '不设截止时间';
      const left = Math.max(0, deadline - Date.now());
      const minutes = Math.ceil(left / 60000);
      return left === 0 ? '已到期' : `剩余约 ${minutes} 分钟`;
    }

    function RunRow(props) {
      const { run, busy, onToggle } = props;
      return h('li', { className: 'agr-item' },
        h('div', { className: 'agr-head' },
          h('span', { className: 'agr-task', title: run.task }, run.task),
          h('span', { className: 'agr-badge ' + (run.governed ? 'on' : 'off') }, run.governed ? '已管控' : '不管控')),
        h('p', { className: 'agr-meta' }, `${run.status} · ${formatDeadline(run.deadline, run.governed)} · ${run.runId}`),
        h('button', {
          className: run.governed ? 'agr-btn ghost' : 'agr-btn',
          disabled: busy,
          onClick: () => onToggle(run.runId, !run.governed),
        }, run.governed ? '解除管控' : '对此对话开启管控'));
    }

    function Panel() {
      const [runs, setRuns] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(undefined);
      const [note, setNote] = React.useState(undefined);

      const refresh = React.useCallback(async () => {
        try {
          const value = await call('/runs');
          setRuns(value.runs || []);
          setError(undefined);
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        }
      }, []);

      React.useEffect(() => {
        let alive = true;
        const tick = () => { if (alive) void refresh(); };
        tick();
        const timer = window.setInterval(tick, 30000);
        return () => { alive = false; window.clearInterval(timer); };
      }, [refresh]);

      const toggle = async (runId, enabled) => {
        setBusy(true);
        setNote(undefined);
        try {
          await call('/governance', { runId, enabled });
          setNote(enabled ? '已开启管控' : '已解除管控');
          await refresh();
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy(false);
        }
      };

      const status = error || note;
      return h('div', { className: 'agr-page' },
        h('style', null, styles),
        h('h3', null, '运行管控（agent-sandbox-runtime）'),
        h('p', { className: 'agr-hint' }, '默认不管控：对话不会被运行时策略、截止时间或预算打断。只有你在这里开启管控的对话才受限制。'),
        status !== undefined && h('div', { className: 'agr-msg', role: 'status' }, status),
        h('ul', { className: 'agr-list' },
          runs.length === 0
            ? h('li', { className: 'agr-item' }, '（暂无运行记录）')
            : runs.map(run => h(RunRow, { key: run.runId, run, busy, onToggle: toggle }))));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'agent-sandbox-runtime-governance',
          order: 61,
          label: () => '运行管控',
        }, Panel)), 'agent-sandbox-runtime: governance page');
      },
    };
  },
});
