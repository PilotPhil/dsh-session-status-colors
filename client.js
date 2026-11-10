/**
 * dsh-session-status-colors —— 侧栏会话行的状态配色 + 桌面红绿灯（Client 半）。
 *
 * 四块内容，全部挂在插件自己的 effect 上，卸载即撤销：
 *   1. 往官方的 `sidebar.session.row.trailing` 座位注册一个不占位的空组件，
 *      由它读该行 Session 的实时状态，把 `data-dshss` 写到所在的行元素上；
 *   2. 注入一段以 `data-dshss` 为唯一作用域的样式，给行加左侧色条与淡色底；
 *   3. 往 `plugins.bundle.config` 注册本 bundle 的设置页（三个状态色、底色强度、
 *      恢复默认、桌面红绿灯开关）；
 *   4. 往 `shell.overlay` 注册一个只算数、不画东西的组件：把红/黄/绿各几个会话
 *      通过本机回环端口发给 Host 半，由它转给独立的桌面置顶窗口。
 *
 * 状态来源是官方 ui-session 服务发布的每会话快照：
 *   { running, pendingInteraction?: 'approval'|'plan-review'|'question', completionUnread }
 * 判定顺序与官方 `sessionStatuses()` 一致：等待交互 > 正在运行 > 完成未查看 > 空闲。
 *
 * 不监听 DOM、不做全局扫描、不写 body、不改别人的样式；失效方式一律是
 * “颜色不显示 / 小球不出现”，不会抛到宿主流程里。
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
    /** Host 半用来告诉页面回环端口号的只读路由。 */
    const BRIDGE_ROUTE = '/dsh-session-status-colors/bridge.json';
    /** 心跳间隔：超过它 Host 会认为页面已经不在了。 */
    const HEARTBEAT_MS = 4000;

    /**
     * 默认值：字面上的红 / 黄 / 绿，底色强度 45%，桌面红绿灯默认关闭。
     *
     * 注意这里不用主题的 `--dsw-alias-state-*-primary`：DSH 主题里「完成」用的是
     * 蓝紫（实测 #3900D6），和「跑完待检查＝绿」的预期不符，所以默认给固定色值。
     * 主题 token 仍作为运行时兜底保留（见 TOKENS / colorExpression）。
     */
    const DEFAULTS = Object.freeze({
      running: '#E5484D',
      waiting: '#FFC71F',
      done: '#2F9E44',
      strength: 45,
      overlay: false,
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
     * 归一化设置对象：只接受合法的十六进制颜色、0–100 的整数强度与布尔开关。
     * @param {unknown} raw - 来自 localStorage 或界面改动的不受信任值。
     * @returns {{ running: string, waiting: string, done: string, strength: number, overlay: boolean }}
     */
    function normalizeSettings(raw) {
      const next = {
        running: DEFAULTS.running,
        waiting: DEFAULTS.waiting,
        done: DEFAULTS.done,
        strength: DEFAULTS.strength,
        overlay: DEFAULTS.overlay,
      };
      if (raw === null || typeof raw !== 'object') return next;
      for (const key of ['running', 'waiting', 'done']) {
        const value = raw[key];
        if (typeof value === 'string' && HEX.test(value)) next[key] = value;
      }
      if (typeof raw.strength === 'number' && Number.isFinite(raw.strength)) {
        next.strength = Math.min(100, Math.max(0, Math.round(raw.strength)));
      }
      if (typeof raw.overlay === 'boolean') next.overlay = raw.overlay;
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
     * 把任意 CSS 颜色文本折算成 `#RRGGBB`（桌面窗口只认这个格式）。
     * @param {string} value - 例如 `#e5484d`、`#abc`、`rgb(229, 72, 77)`。
     * @returns {string|null} 六位十六进制，无法识别时为 null。
     */
    function toHex(value) {
      if (typeof value !== 'string') return null;
      const text = value.trim();
      if (HEX.test(text)) return text.toUpperCase();
      const short = /^#([0-9a-fA-F]{3})$/.exec(text);
      if (short !== null) {
        const [r, g, b] = short[1];
        return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
      }
      const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
      if (rgb === null) return null;
      const channel = (input) => {
        const number = Math.min(255, Math.max(0, Math.round(Number(input))));
        return number.toString(16).padStart(2, '0');
      };
      return `#${channel(rgb[1])}${channel(rgb[2])}${channel(rgb[3])}`.toUpperCase();
    }

    /**
     * 一个状态在桌面窗口里实际要用的颜色。
     * @param {'running'|'waiting'|'done'} key
     * @param {typeof DEFAULTS} settings
     * @returns {string} 六位十六进制。
     */
    function resolveHex(key, settings) {
      const custom = settings[key];
      if (typeof custom === 'string' && HEX.test(custom)) return custom.toUpperCase();
      try {
        const computed = getComputedStyle(document.documentElement).getPropertyValue(TOKENS[key]);
        const hex = toHex(computed);
        if (hex !== null) return hex;
      } catch {
        /* 取不到就退回兜底色。 */
      }
      return FALLBACK_HEX[key].toUpperCase();
    }

    /* ------------------------------------------------------------------ 回环通道 */

    let bridgePort = 0;
    let bridgeAttemptAt = 0;

    /**
     * 向 Host 查回环端口号（同源只读路由，失败时退避 3 秒再试）。
     * @returns {Promise<number>} 端口；未知时为 0。
     */
    async function resolveBridgePort() {
      if (bridgePort > 0) return bridgePort;
      const now = Date.now();
      if (now - bridgeAttemptAt < 3000) return 0;
      bridgeAttemptAt = now;
      try {
        const response = await fetch(BRIDGE_ROUTE, { cache: 'no-store' });
        const data = await response.json();
        if (data !== null && typeof data === 'object' && typeof data.port === 'number' && data.port > 0) {
          bridgePort = data.port;
        }
      } catch {
        bridgePort = 0;
      }
      return bridgePort;
    }

    /**
     * 把计数与颜色发给 Host。
     * @param {{ enabled: boolean, counts: number[], colors: string[] }} payload
     * @param {boolean} [beacon] - 页面即将卸载时用 sendBeacon，请求不会被取消。
     * @returns {Promise<boolean>} 是否发出。
     */
    async function postState(payload, beacon = false) {
      const port = await resolveBridgePort();
      if (port <= 0) return false;
      const url = `http://127.0.0.1:${port}/state`;
      const body = JSON.stringify(payload);
      if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        try {
          return navigator.sendBeacon(url, body);
        } catch {
          /* 退回普通 fetch。 */
        }
      }
      try {
        await fetch(url, { method: 'POST', mode: 'no-cors', cache: 'no-store', body });
        return true;
      } catch {
        bridgePort = 0;
        return false;
      }
    }

    /* ------------------------------------------------------------------ 状态判定 */

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
     * 这条会话是否不该计入桌面红绿灯：归档的、以及子代理来源的（侧栏本来就不显示）。
     * @param {object|undefined} summaries - `useSessions` 的快照。
     * @param {string} sessionId
     * @returns {boolean} true 表示跳过。
     */
    function isHiddenSession(summaries, sessionId) {
      if (summaries === null || summaries === undefined) return false;
      const byId = summaries.byId;
      if (byId === null || byId === undefined) return false;
      const summary = byId[sessionId];
      if (summary === null || summary === undefined) return false;
      if (summary.origin === 'subagent') return true;
      return summary.archived === true || summary.archive === true || summary.archivedAt !== undefined;
    }

    /**
     * 统计三种状态各有多少个未归档会话。
     * @param {Map<string, object>|undefined} statuses - `useSessionStatus` 的快照。
     * @param {object|undefined} summaries - `useSessions` 的快照。
     * @returns {[number, number, number]} 运行中、等待中、完成未读。
     */
    function countStates(statuses, summaries) {
      const counts = [0, 0, 0];
      if (statuses === null || statuses === undefined || typeof statuses.forEach !== 'function') return counts;
      statuses.forEach((status, sessionId) => {
        if (isHiddenSession(summaries, sessionId)) return;
        const state = classify(status);
        if (state === 'running') counts[0] += 1;
        else if (state === 'waiting') counts[1] += 1;
        else if (state === 'done') counts[2] += 1;
      });
      return counts;
    }

    /* ------------------------------------------------------------------ 组件 */

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

    /**
     * 桌面红绿灯的数据源：只算数、不渲染任何东西。
     * 挂在 frame 级的 `shell.overlay` 上，所以缩起侧栏、切到别的面板都还在。
     * @param {{ useSessionStatus?: Function, useSessions?: Function }} props
     * @returns null（不产生 DOM）。
     */
    function OverlayBridge(props) {
      const useStatus = typeof props.useSessionStatus === 'function' ? props.useSessionStatus : useNoStatus;
      const useSummaries = typeof props.useSessions === 'function' ? props.useSessions : useNoStatus;

      const statuses = useStatus((snapshot) => snapshot);
      const summaries = useSummaries((snapshot) => snapshot);

      const [settings, setLocal] = React.useState(getSettings);
      React.useEffect(() => subscribeSettings(() => setLocal(getSettings())), []);

      const enabled = settings.overlay === true;
      const counts = React.useMemo(() => countStates(statuses, summaries), [statuses, summaries]);
      const signature = `${counts[0]},${counts[1]},${counts[2]}`;

      // 计数、开关、配色任一变化都重发一次；另外每 4 秒补一次心跳，
      // 让 Host 知道页面还在（不然桌面窗口会按“状态过期”自行关闭）。
      React.useEffect(() => {
        let cancelled = false;
        let timer = null;

        const send = () => {
          if (cancelled) return;
          const current = getSettings();
          void postState({
            enabled: current.overlay === true,
            counts,
            colors: [resolveHex('running', current), resolveHex('waiting', current), resolveHex('done', current)],
          });
        };

        send();
        timer = window.setInterval(send, HEARTBEAT_MS);
        return () => {
          cancelled = true;
          if (timer !== null) window.clearInterval(timer);
        };
      }, [signature, enabled, settings.running, settings.waiting, settings.done]);

      // 页面关闭时告诉 Host 收掉窗口，避免它等 20 秒超时。
      React.useEffect(() => () => {
        if (getSettings().overlay !== true) return;
        void postState({ enabled: false, counts: [0, 0, 0], colors: [] }, true);
      }, []);

      return null;
    }

    /* ------------------------------------------------------------------ 设置页 */

    /** 界面文案（运行时字典；bundle 展示用的标题/描述在 locale/*.json）。 */
    const zh = {
      colorRunning: '运行中',
      colorWaiting: '等待你处理',
      colorDone: '完成待查看',
      hintTheme: '跟随主题',
      hintDefault: '默认',
      hintCustom: '自定义',
      strength: '底色强度',
      strengthHint: '左侧色条保持全强度，只调整底色浓度',
      reset: '恢复默认',
      pickColor: '选择{name}的颜色',
      summary: '红 / 黄 / 绿 · 底色 {n}%',
      panelTitle: '会话行配色',
      overlay: '桌面红绿灯',
      overlayHint: '在桌面上始终置顶显示三个状态的会话数量，可拖动位置',
      overlayOn: '已开启',
      overlayOff: '已关闭',
    };
    const en = {
      colorRunning: 'Running',
      colorWaiting: 'Waiting for you',
      colorDone: 'Finished, unreviewed',
      hintTheme: 'Follows theme',
      hintDefault: 'Default',
      hintCustom: 'Custom',
      strength: 'Row tint',
      strengthHint: 'The left bar stays fully opaque; this changes the tint only',
      reset: 'Restore defaults',
      pickColor: 'Choose the {name} colour',
      summary: 'Red / amber / green · {n}% tint',
      panelTitle: 'Session row colours',
      overlay: 'Desktop traffic light',
      overlayHint: 'Shows the three session counts in an always-on-top window you can drag',
      overlayOn: 'On',
      overlayOff: 'Off',
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
     * bundle 设置页：三个状态色 + 底色强度 + 桌面开关 + 恢复默认。
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
        const isDefault = custom !== '' && custom.toUpperCase() === DEFAULTS[key];
        return h('div', { className: 'dshss-row' },
          h('div', { className: 'dshss-text' },
            h('span', { className: 'dshss-label' }, label),
            h('span', { className: 'dshss-hint' }, isDefault ? translate('hintDefault') : translate('hintCustom'))),
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
        h('div', { className: 'dshss-row' },
          h('div', { className: 'dshss-text' },
            h('span', { className: 'dshss-label' }, translate('overlay')),
            h('span', { className: 'dshss-hint' }, translate('overlayHint'))),
          h('div', { className: 'dshss-controls' },
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': settings.overlay,
              'aria-label': translate('overlay'),
              className: `dshss-switch${settings.overlay ? ' dshss-switch-on' : ''}`,
              onClick: () => updateSettings({ overlay: !settings.overlay }),
            },
            h('span', { className: 'dshss-switch-knob' })),
            h('span', { className: 'dshss-value' }, translate(settings.overlay ? 'overlayOn' : 'overlayOff')))),
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
.dshss-value { font-size: 12px; min-width: 52px; text-align: right; color: var(--dsw-alias-label-secondary, #8b8b8b); font-variant-numeric: tabular-nums; }
.dshss-range { width: 180px; accent-color: var(--dsw-alias-brand-primary, #3d6df6); }
.dshss-switch { position: relative; width: 38px; height: 22px; border-radius: 11px; padding: 0; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2, #b0b0b0); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.18)); transition: background 120ms ease, border-color 120ms ease; }
.dshss-switch-on { background: var(--dsw-alias-brand-primary, #3d6df6); border-color: var(--dsw-alias-brand-primary, #3d6df6); }
.dshss-switch-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 120ms ease; }
.dshss-switch-on .dshss-switch-knob { transform: translateX(16px); }
.dshss-footer { display: flex; justify-content: flex-end; padding-top: 4px; }
.dshss-reset { font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer; color: var(--dsw-alias-label-primary, inherit); background: transparent; border: 1px solid var(--dsw-alias-border-l2, #b0b0b0); }
.dshss-reset:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12)); }
.dshss-summary { font-size: 12px; color: var(--dsw-alias-label-secondary, #8b8b8b); }
`;

    /**
     * 由设置生成整段行样式。只使用 `data-dshss` 作用域，卸载时随 style 标签一起消失。
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

      // frame 级的隐形岗位：只负责把三个计数发给 Host。
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        {
          name: 'shell.overlay',
          id: 'dshss.overlay-bridge',
          order: 100,
        },
        OverlayBridge,
      ));
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
