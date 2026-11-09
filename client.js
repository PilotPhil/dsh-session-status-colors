/**
 * dsh-session-status-colors —— 侧栏会话行的状态配色（Client 半）。
 *
 * 三块内容，全部挂在插件自己的 effect 上，卸载即撤销：
 *   1. 往官方的 `sidebar.session.row.trailing` 座位注册一个不占位的空组件，
 *      由它读该行 Session 的实时状态，把 `data-dshss` 写到所在的行元素上；
 *   2. 注入一段以 `data-dshss` 为唯一作用域的样式，给行加左侧色条与淡色底；
 *   3. 往 `plugins.bundle.config` 注册本 bundle 的设置页（三个状态色、底色强度、
 *      恢复默认），改动即时反映到样式上。
 *
 * 状态来源是官方 ui-session 服务发布的每会话快照：
 *   { running, pendingInteraction?: 'approval'|'plan-review'|'question', completionUnread }
 * 判定顺序与官方 `sessionStatuses()` 一致：等待交互 > 正在运行 > 完成未查看 > 空闲。
 *
 * 不监听 DOM、不做全局扫描、不写 body、不改别人的样式；失效方式一律是
 * “颜色不显示”，不会抛到宿主流程里。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-status-colors',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 会话行根元素的标记；官方用它给 AnimatedRows 做行键，形如 `session:<id>`。 */
    const ROW_SELECTOR = '[data-row-key^="session:"]';
    /** 我们写在行上的状态属性；样式只认这个属性，卸载时随之失效。 */
    const ROW_ATTR = 'data-dshss';
    /** 本插件的 locale 命名空间。 */
    const NS = 'sidebar.sessionStatusColors';
    /** 设置持久化键（浏览器本地，不进 profile 配置）。 */
    const SETTINGS_KEY = 'dsh-session-status-colors/settings';

    /** 默认值：红 / 黄 / 绿，底色强度 45%。 */
    const DEFAULTS = Object.freeze({
      running: '',
      waiting: '',
      done: '',
      strength: 45,
    });

    /** 各状态在未自定义时跟随主题状态 token（浅色/深色各自适配）。 */
    const TOKENS = Object.freeze({
      running: '--dsw-alias-state-error-primary',
      waiting: '--dsw-alias-state-warn-primary',
      done: '--dsw-alias-state-success-primary',
    });

    /** 颜色选择器的兜底值，仅用于让取色器有起点；实际默认仍走主题 token。 */
    const FALLBACK_HEX = Object.freeze({
      running: '#e5484d',
      waiting: '#d9a300',
      done: '#2f9e44',
    });

    const HEX = /^#[0-9a-fA-F]{6}$/;

    /**
     * 归一化设置对象：只接受合法的十六进制颜色与 0–100 的整数强度。
     * @param {unknown} raw - 来自 localStorage 或界面改动的不受信任值。
     * @returns {{ running: string, waiting: string, done: string, strength: number }}
     */
    function normalizeSettings(raw) {
      const next = { running: DEFAULTS.running, waiting: DEFAULTS.waiting, done: DEFAULTS.done, strength: DEFAULTS.strength };
      if (raw === null || typeof raw !== 'object') return next;
      for (const key of ['running', 'waiting', 'done']) {
        const value = raw[key];
        if (typeof value === 'string' && HEX.test(value)) next[key] = value;
      }
      if (typeof raw.strength === 'number' && Number.isFinite(raw.strength)) {
        next.strength = Math.min(100, Math.max(0, Math.round(raw.strength)));
      }
      return next;
    }

    /** 读取本地设置；任何异常都退回默认值，绝不让设置坏掉整个插件。 */
    function loadSettings() {
      try {
        if (typeof localStorage === 'undefined') return { ...DEFAULTS };
        const text = localStorage.getItem(SETTINGS_KEY);
        return text === null ? { ...DEFAULTS } : normalizeSettings(JSON.parse(text));
      } catch {
        return { ...DEFAULTS };
      }
    }

    /** 保存本地设置；配额或隐私模式失败时忽略（本次会话内仍然生效）。 */
    function persistSettings(value) {
      try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
      } catch {
        /* 存不下就只影响下次启动，不影响当前显示。 */
      }
    }

    let currentSettings = loadSettings();
    const settingsListeners = new Set();

    /** @returns 当前设置（只读用法）。 */
    function getSettings() {
      return currentSettings;
    }

    /** 合并并广播一次设置改动。 */
    function updateSettings(patch) {
      currentSettings = normalizeSettings({ ...currentSettings, ...patch });
      persistSettings(currentSettings);
      for (const listener of [...settingsListeners]) {
        try {
          listener();
        } catch {
          /* 单个订阅者出错不影响其他订阅者。 */
        }
      }
    }

    /** @returns 取消订阅函数。 */
    function subscribeSettings(listener) {
      settingsListeners.add(listener);
      return () => {
        settingsListeners.delete(listener);
      };
    }

    /**
     * 一个状态最终使用的颜色值：自定义优先，否则跟随主题 token。
     * @param {'running'|'waiting'|'done'} key
     * @param {typeof DEFAULTS} settings
     * @returns {string} CSS 颜色表达式。
     */
    function colorExpression(key, settings) {
      const custom = settings[key];
      if (typeof custom === 'string' && HEX.test(custom)) return custom;
      return `var(${TOKENS[key]}, ${FALLBACK_HEX[key]})`;
    }

    /**
     * 由设置生成整段样式。只使用 `data-dshss` 作用域，卸载时随 style 标签一起消失。
     * @param {typeof DEFAULTS} settings
     * @returns {string} CSS 文本。
     */
    function buildCss(settings) {
      const strength = `${settings.strength}%`;
      return `
[data-row-key^="session:"][data-dshss="running"] { --dshss-c: ${colorExpression('running', settings)}; }
[data-row-key^="session:"][data-dshss="waiting"] { --dshss-c: ${colorExpression('waiting', settings)}; }
[data-row-key^="session:"][data-dshss="done"]    { --dshss-c: ${colorExpression('done', settings)}; }

[data-row-key^="session:"][data-dshss] {
  background-image: linear-gradient(90deg, var(--dshss-c) 0 3px, transparent 3px);
  background-repeat: no-repeat;
  background-size: 100% 100%;
}

@supports (color: color-mix(in srgb, red 10%, transparent)) {
  [data-row-key^="session:"][data-dshss] {
    background-image:
      linear-gradient(90deg, var(--dshss-c) 0 3px, transparent 3px),
      linear-gradient(
        color-mix(in srgb, var(--dshss-c) ${strength}, transparent),
        color-mix(in srgb, var(--dshss-c) ${strength}, transparent)
      );
  }
}
`;
    }

    /** 效果阶段优先用 layout effect，没有就退回 effect（只为减少一帧闪烁）。 */
    const useLayoutEffect = React.useLayoutEffect || React.useEffect;

    /**
     * 官方座位没有注入 status 钩子时的替代品。
     * 用它保证 hook 调用顺序恒定，不会因为座位契约变化而炸掉整行。
     */
    function useNoStatus() {
      return undefined;
    }

    /**
     * 把一个会话的实时快照收敛成四种状态。
     * @param {{ running?: boolean, pendingInteraction?: string, completionUnread?: boolean }|undefined} status
     * @returns {'waiting'|'running'|'done'|''} 空字符串表示不着色。
     */
    function classify(status) {
      if (status === undefined || status === null) return '';
      if (status.pendingInteraction !== undefined && status.pendingInteraction !== null) return 'waiting';
      if (status.running === true) return 'running';
      if (status.completionUnread === true) return 'done';
      return '';
    }

    /**
     * 行尾座位里的纯功能组件：不可见、不占位，只负责给所在行打状态标记。
     * @param {{ sessionId: string, useSessionStatus?: Function, useSessions?: Function }} props
     * @returns 一个隐藏的空 span，仅作为定位行元素与承载 effect 的锚点。
     */
    function SessionStatusMarker(props) {
      const sessionId = props.sessionId;
      const seatRef = React.useRef(null);

      // 钩子必须无条件调用：座位没注入时退回空实现，而不是条件调用。
      const useStatus = typeof props.useSessionStatus === 'function' ? props.useSessionStatus : useNoStatus;
      const useSummaries = typeof props.useSessions === 'function' ? props.useSessions : useNoStatus;

      const status = useStatus((snapshot) => (
        snapshot !== undefined && snapshot !== null && typeof snapshot.get === 'function'
          ? snapshot.get(sessionId)
          : undefined
      ));
      const summary = useSummaries((snapshot) => (
        snapshot !== undefined && snapshot !== null && snapshot.byId !== undefined
          ? snapshot.byId[sessionId]
          : undefined
      ));

      // 官方不给归档行显示状态点（状态只放悬浮卡），我们也保持原样。
      const archived = summary !== undefined && summary !== null
        && (summary.archived === true || summary.archive === true);
      const state = archived ? '' : classify(status);

      useLayoutEffect(() => {
        const seat = seatRef.current;
        if (seat === null || typeof seat.closest !== 'function') return undefined;
        const row = seat.closest(ROW_SELECTOR);
        if (row === null) return undefined;
        if (state === '') {
          row.removeAttribute(ROW_ATTR);
          return undefined;
        }
        row.setAttribute(ROW_ATTR, state);
        // 行被卸载、状态变化、或插件被卸载时，标记一并撤掉。
        return () => {
          row.removeAttribute(ROW_ATTR);
        };
      }, [state, sessionId]);

      return h('span', {
        ref: seatRef,
        'data-dshss-seat': '',
        'aria-hidden': 'true',
        hidden: true,
      });
    }

    /** 界面文案（运行时字典；bundle 展示用的标题/描述在 locale/*.json）。 */
    const zh = {
      colorRunning: '运行中',
      colorWaiting: '等待你处理',
      colorDone: '完成待查看',
      hintTheme: '跟随主题',
      hintCustom: '自定义',
      strength: '底色强度',
      strengthHint: '左侧色条保持全强度，只调整底色浓度',
      reset: '恢复默认',
      pickColor: '选择{name}的颜色',
      summary: '红 / 黄 / 绿 · 底色 {n}%',
      panelTitle: '会话行配色',
    };
    const en = {
      colorRunning: 'Running',
      colorWaiting: 'Waiting for you',
      colorDone: 'Finished, unreviewed',
      hintTheme: 'Follows theme',
      hintCustom: 'Custom',
      strength: 'Row tint',
      strengthHint: 'The left bar stays fully opaque; this changes the tint only',
      reset: 'Restore defaults',
      pickColor: 'Choose the {name} colour',
      summary: 'Red / amber / green · {n}% tint',
      panelTitle: 'Session row colours',
    };

    /**
     * 取色器输入（原生 color input 只给六位十六进制，正好是我们要的格式）。
     * @param {{ name: string, value: string, onChange: (value: string) => void, t: Function }} props
     */
    function ColorControl({ name, value, onChange, t }) {
      return h('div', { className: 'dshss-controls' },
        h('input', {
          type: 'color',
          className: 'dshss-color',
          value,
          'aria-label': t('pickColor', { name }),
          title: value,
          onChange: (event) => onChange(event.target.value),
        }),
        h('span', { className: 'dshss-value' }, value));
    }

    /**
     * bundle 设置页：三个状态色 + 底色强度 + 恢复默认。
     * @param {{ view?: string, t?: Function }} props - slot 注入的属性。
     */
    function SettingsPanel(props) {
      const translate = typeof props.t === 'function' ? props.t : (key) => key;
      const [settings, setLocal] = React.useState(getSettings);

      React.useEffect(() => subscribeSettings(() => setLocal(getSettings())), []);

      if (props.view === 'summary') {
        return h('span', { className: 'dshss-summary' }, translate('summary', { n: settings.strength }));
      }

      const row = (key, label) => {
        const custom = HEX.test(settings[key]) ? settings[key] : '';
        return h('div', { className: 'dshss-row' },
          h('div', { className: 'dshss-text' },
            h('span', { className: 'dshss-label' }, label),
            h('span', { className: 'dshss-hint' }, custom === '' ? translate('hintTheme') : translate('hintCustom'))),
          h(ColorControl, {
            name: label,
            value: custom === '' ? FALLBACK_HEX[key] : custom,
            t: translate,
            onChange: (value) => updateSettings({ [key]: value }),
          }));
      };

      return h('div', { className: 'dshss-panel' },
        h('div', { className: 'dshss-title' }, translate('panelTitle')),
        row('running', translate('colorRunning')),
        row('waiting', translate('colorWaiting')),
        row('done', translate('colorDone')),
        h('div', { className: 'dshss-row' },
          h('div', { className: 'dshss-text' },
            h('span', { className: 'dshss-label' }, translate('strength')),
            h('span', { className: 'dshss-hint' }, translate('strengthHint'))),
          h('div', { className: 'dshss-controls' },
            h('input', {
              type: 'range',
              className: 'dshss-range',
              min: 0,
              max: 100,
              step: 5,
              value: settings.strength,
              'aria-label': translate('strength'),
              onChange: (event) => updateSettings({ strength: Number(event.target.value) }),
            }),
            h('span', { className: 'dshss-value' }, `${settings.strength}%`))),
        h('div', { className: 'dshss-footer' },
          h('button', {
            type: 'button',
            className: 'dshss-reset',
            onClick: () => updateSettings({ ...DEFAULTS }),
          }, translate('reset'))));
    }

    /** 设置页样式；只作用于本插件自己的类名。 */
    const PANEL_CSS = `
.dshss-panel { display: flex; flex-direction: column; gap: 14px; max-width: 560px; }
.dshss-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.dshss-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.dshss-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dshss-label { font-size: 13px; color: var(--dsw-alias-label-primary, inherit); }
.dshss-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #8b8b8b); }
.dshss-controls { display: flex; align-items: center; gap: 10px; flex: none; }
.dshss-color { width: 32px; height: 24px; padding: 0; border: 1px solid var(--dsw-alias-border-l1, #d0d0d0); border-radius: 6px; background: transparent; cursor: pointer; }
.dshss-value { font-size: 12px; min-width: 42px; text-align: right; color: var(--dsw-alias-label-secondary, #8b8b8b); font-variant-numeric: tabular-nums; }
.dshss-range { width: 180px; accent-color: var(--dsw-alias-brand-primary, #3d6df6); }
.dshss-footer { display: flex; justify-content: flex-end; padding-top: 4px; }
.dshss-reset { font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer; color: var(--dsw-alias-label-primary, inherit); background: transparent; border: 1px solid var(--dsw-alias-border-l2, #b0b0b0); }
.dshss-reset:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12)); }
.dshss-summary { font-size: 12px; color: var(--dsw-alias-label-secondary, #8b8b8b); }
`;

    /**
     * 注册本插件的全部资源。
     * @param {import('@deepseek-ai/cordis').Context} ctx - Client 根上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-status-colors: dictionaries');

      // 行着色样式：内容随设置实时重写，卸载时整个标签移除。
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {};
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-session-status-colors';
        tag.dataset.pluginCss = 'dsh-session-status-colors/session-status-colors.css';
        tag.textContent = buildCss(getSettings());
        document.head.appendChild(tag);
        const unsubscribe = subscribeSettings(() => {
          tag.textContent = buildCss(getSettings());
        });
        return () => {
          unsubscribe();
          tag.remove();
        };
      }, 'dsh-session-status-colors: row styles');

      // 设置页样式：只含本插件自己的类名。
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {};
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-session-status-colors';
        tag.dataset.pluginCss = 'dsh-session-status-colors/settings.css';
        tag.textContent = PANEL_CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'dsh-session-status-colors: settings styles');

      ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register(
        {
          name: 'sidebar.session.row.trailing',
          id: 'dshss.status-tint',
          order: 100,
        },
        SessionStatusMarker,
      ));

      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
        {
          name: 'plugins.bundle.config',
          key: 'dsh-session-status-colors',
          locale: NS,
        },
        SettingsPanel,
      ));
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
