// dsh-fuyu-switch —— 客户端：在「设置 → 通用」里注册一行，就地展开小面板。
//
// 只注册 settings.general.item（不是 settings.section，不占独立板块/独立 tab）。
// 状态只在「展开面板 / 点按钮」时向后端要一次，不轮询、不缓存、不落盘。

window.__ModuleLoader__.load({
  id: 'dsh-fuyu-switch',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useCallback } = React

    const API = '/dsh-fuyu-switch'

    const styles = {
      box: {
        display: 'flex',
        flexDirection: 'column',
        borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22))'
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        padding: '12px 0'
      },
      left: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 },
      label: { fontSize: '14px', fontWeight: 500 },
      hint: { fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
      right: { display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 },
      pill: (bg, fg, bd) => ({
        fontSize: '12px',
        padding: '3px 10px',
        borderRadius: '999px',
        fontWeight: 600,
        background: bg,
        color: fg,
        border: '1px solid ' + bd,
        whiteSpace: 'nowrap'
      }),
      btn: {
        fontSize: '13px',
        padding: '6px 14px',
        borderRadius: '7px',
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l3, #555)',
        background: 'var(--dsw-alias-button-floating-fill, transparent)',
        color: 'inherit'
      },
      btnDisabled: { opacity: 0.4, cursor: 'not-allowed' },
      panel: {
        padding: '2px 0 14px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px'
      },
      panelRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      meta: { fontSize: '12px', opacity: 0.65 },
      err: { fontSize: '12px', color: '#ff6b6b' },
      ok: { fontSize: '12px', color: '#3ddc84' }
    }

    const STATE_TEXT = {
      idle: '未运行',
      running: '运行中',
      suspended: '已休眠',
      partial: '部分休眠'
    }

    const STATE_COLOR = {
      idle: ['rgba(128,131,141,.16)', '#9aa0ad', 'rgba(128,131,141,.35)'],
      running: ['rgba(90,220,140,.16)', '#3ddc84', 'rgba(90,220,140,.35)'],
      suspended: ['rgba(255,190,80,.16)', '#e0a83f', 'rgba(255,190,80,.35)'],
      partial: ['rgba(255,190,80,.16)', '#e0a83f', 'rgba(255,190,80,.35)']
    }

    function FuyuSwitchRow() {
      const [open, setOpen] = useState(false)
      const [data, setData] = useState(null)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState(null)

      const refresh = useCallback(async () => {
        try {
          const r = await fetch(API + '/status', { cache: 'no-store' })
          setData(await r.json())
        } catch (e) {
          setMsg({ kind: 'err', text: '读取状态失败：' + (e?.message || e) })
        }
      }, [])

      const toggle = useCallback(() => {
        const next = !open
        setOpen(next)
        setMsg(null)
        if (next) refresh()
      }, [open, refresh])

      const run = useCallback(
        async (action) => {
          setBusy(action)
          setMsg(null)
          try {
            const r = await fetch(API + '/action?action=' + action, { cache: 'no-store' })
            const result = await r.json()
            if (result && result.ok) {
              setData(result)
              const changed = result.changed == null ? '' : '（影响 ' + result.changed + ' 个）'
              setMsg({ kind: 'ok', text: '已完成' + changed })
            } else {
              setMsg({ kind: 'err', text: (result && result.error) || '操作失败' })
            }
          } catch (e) {
            setMsg({ kind: 'err', text: '操作失败：' + (e?.message || e) })
          } finally {
            setBusy('')
          }
        },
        [],
      )

      const state = data && data.ok ? data.state : null
      const colors = STATE_COLOR[state] || ['transparent', 'inherit', 'transparent']
      const total = data && data.ok ? data.total : null
      const suspended = data && data.ok ? data.suspended : 0
      const canSleep = state === 'running' || state === 'partial'
      const canWake = state === 'suspended' || state === 'partial'
      const canClose = state === 'running' || state === 'suspended' || state === 'partial'

      const pillText = state
        ? total + ' 个进程 · ' + STATE_TEXT[state]
        : open
          ? '读取中…'
          : '点开查看'

      return h(
        'div',
        { style: styles.box },
        h(
          'div',
          { style: styles.row },
          h(
            'div',
            { style: styles.left },
            h('div', { style: styles.label }, 'DeepSeek 开关'),
            h('div', { style: styles.hint }, '休眠（挂起，可秒恢复）/ 唤醒 / 关闭 DeepSeek Harness'),
          ),
          h(
            'div',
            { style: styles.right },
            h('span', { style: styles.pill(colors[0], colors[1], colors[2]) }, pillText),
            h(
              'button',
              { type: 'button', style: styles.btn, onClick: toggle },
              open ? '收起' : '管理',
            ),
          ),
        ),
        open
          ? h(
              'div',
              { style: styles.panel },
              h(
                'div',
                { style: styles.meta },
                state === 'idle'
                  ? '当前没有运行中的 DeepSeek Harness 进程。'
                  : '已挂起 ' + suspended + ' 个，运行中 ' + (total - suspended) + ' 个。',
              ),
              h(
                'div',
                { style: styles.panelRow },
                h(
                  'button',
                  {
                    type: 'button',
                    style: canSleep && !busy ? styles.btn : Object.assign({}, styles.btn, styles.btnDisabled),
                    disabled: !canSleep || !!busy,
                    onClick: () => run('sleep'),
                  },
                  busy === 'sleep' ? '休眠中…' : '休眠',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    style: canWake && !busy ? styles.btn : Object.assign({}, styles.btn, styles.btnDisabled),
                    disabled: !canWake || !!busy,
                    onClick: () => run('wake'),
                  },
                  busy === 'wake' ? '唤醒中…' : '唤醒',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    style: canClose && !busy ? styles.btn : Object.assign({}, styles.btn, styles.btnDisabled),
                    disabled: !canClose || !!busy,
                    onClick: () => run('close'),
                  },
                  busy === 'close' ? '关闭中…' : '关闭',
                ),
                h(
                  'button',
                  { type: 'button', style: styles.btn, disabled: !!busy, onClick: refresh },
                  '刷新状态',
                ),
              ),
              msg ? h('div', { style: msg.kind === 'ok' ? styles.ok : styles.err }, msg.text) : null,
            )
          : null,
      )
    }

    // 客户端插件契约：factory 返回带 `apply` 的对象；`inject: ['slots']` 必须有，
    // 否则 apply 在 boot 早期执行时 slots 服务还不存在，整个 web boot 会失败。
    function apply(ctx) {
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          {
            name: 'settings.general.item',
            id: 'fuyu-switch',
            order: 40,
          },
          FuyuSwitchRow,
        ),
      )
    }

    return { inject: ['slots'], apply, name: 'dsh-fuyu-switch' }
  },
})
