import { api } from './api.js'
import { openModal, toast } from './ui.js'
import { refreshTree } from './tree.js'
import { store } from './store.js'

export function openConnDialog(existing = null) {
  const { body, close } = openModal(existing ? '编辑连接' : '新建连接', { width: 500 })
  const cfg = existing || {
    id: crypto.randomUUID(),
    name: '', host: '127.0.0.1', port: 3306,
    user: 'root', password: '', database: null, timeout_secs: 8,
    ssh_enabled: false, ssh_host: '', ssh_port: 22, ssh_user: '', ssh_password: '', ssh_key_path: null,
    ssl_enabled: false, ssl_ca: null, ssl_cert: null, ssl_key: null,
  }
  body.innerHTML = `
    <div class="form-grid">
      <label>连接名称</label>
      <input type="text" id="f-name" placeholder="例：本地开发库" value="${escAttr(cfg.name)}" />
      <label>主机</label>
      <input type="text" id="f-host" value="${escAttr(cfg.host)}" />
      <label>端口</label>
      <input type="number" id="f-port" value="${cfg.port}" />
      <label>用户名</label>
      <input type="text" id="f-user" value="${escAttr(cfg.user)}" />
      <label>密码</label>
      <input type="password" id="f-pass" value="${escAttr(cfg.password)}" />
      <label>默认数据库</label>
      <input type="text" id="f-db" placeholder="可选，连接后也可切换" value="${escAttr(cfg.database || '')}" />
      <label>超时(秒)</label>
      <input type="number" id="f-timeout" value="${cfg.timeout_secs}" />
      <div class="form-hint">连接配置（含密码）保存在本机应用数据目录，仅本机可读。</div>

      <div class="ssh-divider">
        <label class="chk" style="justify-content:flex-start;display:flex;gap:6px;align-items:center">
          <input type="checkbox" id="f-ssh" ${cfg.ssh_enabled ? 'checked' : ''}/> SSH 隧道
        </label>
        <span class="form-hint" style="margin:0">经跳板机访问内网数据库，主机/端口填数据库在跳板机视角的地址</span>
      </div>
    </div>
    <div id="ssh-fields" class="form-grid" style="display:${cfg.ssh_enabled ? '' : 'none'};border-top:1px dashed var(--border);padding-top:10px;margin-top:4px">
      <label>SSH 主机</label>
      <input type="text" id="f-ssh-host" placeholder="跳板机地址" value="${escAttr(cfg.ssh_host)}" />
      <label>SSH 端口</label>
      <input type="number" id="f-ssh-port" value="${cfg.ssh_port || 22}" />
      <label>SSH 用户名</label>
      <input type="text" id="f-ssh-user" value="${escAttr(cfg.ssh_user)}" />
      <label>认证方式</label>
      <select id="f-ssh-auth">
        <option value="password" ${cfg.ssh_key_path ? '' : 'selected'}>密码</option>
        <option value="key" ${cfg.ssh_key_path ? 'selected' : ''}>私钥文件</option>
      </select>
      <label id="l-ssh-secret">密码 / 私钥口令</label>
      <input type="password" id="f-ssh-pass" value="${escAttr(cfg.ssh_password)}" placeholder="私钥认证时此处填私钥口令（可空）" />
      <label id="l-ssh-key" style="display:none">私钥路径</label>
      <input type="text" id="f-ssh-keypath" style="display:none" placeholder="例：/Users/you/.ssh/id_ed25519" value="${escAttr(cfg.ssh_key_path || '')}" />

      <div class="ssh-divider">
        <label class="chk" style="justify-content:flex-start;display:flex;gap:6px;align-items:center">
          <input type="checkbox" id="f-ssl" ${cfg.ssl_enabled ? 'checked' : ''}/> SSL/TLS 加密
        </label>
        <span class="form-hint" style="margin:0">云数据库（RDS 等）常要求开启</span>
      </div>
    </div>
    <div id="ssl-fields" class="form-grid" style="display:${cfg.ssl_enabled ? '' : 'none'};border-top:1px dashed var(--border);padding-top:10px;margin-top:4px">
      <label>CA 证书路径</label>
      <input type="text" id="f-ssl-ca" placeholder="可选，PEM 格式；留空 = 仅加密不验证服务端" value="${escAttr(cfg.ssl_ca || '')}" />
      <label>客户端证书 (PEM)</label>
      <input type="text" id="f-ssl-cert" placeholder="可选，双向认证时填写证书链路径" value="${escAttr(cfg.ssl_cert || '')}" />
      <label>客户端私钥 (PEM)</label>
      <input type="text" id="f-ssl-key" placeholder="可选，与客户端证书配套" value="${escAttr(cfg.ssl_key || '')}" />
    </div>
    <div class="modal-foot">
      <button class="btn" id="btn-test">测试连接</button>
      <span style="flex:1"></span>
      <button class="btn" id="btn-cancel">取消</button>
      <button class="btn btn-primary" id="btn-save">保存</button>
    </div>`

  const val = (id) => body.querySelector(id).value.trim()
  const readCfg = () => {
    const sshOn = body.querySelector('#f-ssh').checked
    const sslOn = body.querySelector('#f-ssl').checked
    const auth = val('#f-ssh-auth')
    return {
      id: cfg.id,
      name: val('#f-name') || val('#f-host') || '未命名连接',
      host: val('#f-host') || '127.0.0.1',
      port: parseInt(val('#f-port')) || 3306,
      user: val('#f-user') || 'root',
      password: body.querySelector('#f-pass').value,
      database: val('#f-db') || null,
      timeout_secs: parseInt(val('#f-timeout')) || 8,
      ssh_enabled: sshOn,
      ssh_host: sshOn ? val('#f-ssh-host') : '',
      ssh_port: sshOn ? (parseInt(val('#f-ssh-port')) || 22) : 0,
      ssh_user: sshOn ? val('#f-ssh-user') : '',
      ssh_password: sshOn ? body.querySelector('#f-ssh-pass').value : '',
      ssh_key_path: sshOn && auth === 'key' ? (val('#f-ssh-keypath') || null) : null,
      ssl_enabled: sslOn,
      ssl_ca: sslOn ? (val('#f-ssl-ca') || null) : null,
      ssl_cert: sslOn ? (val('#f-ssl-cert') || null) : null,
      ssl_key: sslOn ? (val('#f-ssl-key') || null) : null,
    }
  }

  // SSH 开关与认证方式切换
  body.querySelector('#f-ssh').onchange = (e) => {
    body.querySelector('#ssh-fields').style.display = e.target.checked ? '' : 'none'
  }
  body.querySelector('#f-ssl').onchange = (e) => {
    body.querySelector('#ssl-fields').style.display = e.target.checked ? '' : 'none'
  }
  const syncAuthUi = () => {
    const isKey = val('#f-ssh-auth') === 'key'
    body.querySelector('#l-ssh-secret').textContent = isKey ? '私钥口令（可空）' : 'SSH 密码'
    body.querySelector('#f-ssh-pass').placeholder = isKey ? '私钥本身的口令，无则留空' : 'SSH 登录密码'
    body.querySelector('#l-ssh-key').style.display = isKey ? '' : 'none'
    body.querySelector('#f-ssh-keypath').style.display = isKey ? '' : 'none'
  }
  body.querySelector('#f-ssh-auth').onchange = syncAuthUi
  if (cfg.ssh_enabled) syncAuthUi()

  body.querySelector('#btn-cancel').onclick = close
  body.querySelector('#btn-test').onclick = async () => {
    const btn = body.querySelector('#btn-test')
    btn.disabled = true
    btn.textContent = '测试中…'
    try {
      const version = await api.testConnection(readCfg())
      toast(`连接成功，服务器版本 ${version}`, 'ok')
    } catch (e) {
      toast(String(e), 'error', 5000)
    } finally {
      btn.disabled = false
      btn.textContent = '测试连接'
    }
  }
  body.querySelector('#btn-save').onclick = async () => {
    try {
      const c = readCfg()
      await api.saveConnection(c)
      close()
      await refreshTree()
      // 保存后直接尝试连接
      if (!store.treeState[c.id]?.connected) {
        const { connectTo } = await import('./tree.js')
        await connectTo(c)
      }
      toast(`已保存连接「${c.name}」`, 'ok')
    } catch (e) {
      toast(String(e), 'error', 5000)
    }
  }
}

function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

// 暴露给 tree 的删除入口
export async function deleteConn(conn) {
  const { confirmBox } = await import('./ui.js')
  const { ok } = await confirmBox('删除连接', `确定删除连接「${conn.name}」？<br/>仅删除本地保存的配置，不影响数据库。`, { danger: true, okText: '删除' })
  if (!ok) return
  await api.deleteConnection(conn.id)
  store.disconnect(conn.id)
  await refreshTree()
  toast('已删除', 'ok')
}
