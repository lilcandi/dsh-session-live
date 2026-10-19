# 发布 dsh-session-live 到 GitHub + 插件市场

一次性脚本。**不需要手动粘贴 token** —— 走 Git Credential Manager 的浏览器授权。

## 前置检查（脚本会自己跑）

| 项 | 状态 |
|---|---|
| git 仓库 | 已初始化，`main`，提交 `c12fc9b`，49 文件 |
| git 身份 | `lilcandi` / `leoocandi@qq.com` |
| 凭据 helper | `credential.helper=manager`（GCM 已装，会弹浏览器） |
| gh CLI | 无（脚本不用它，全走 REST + git） |
| 网络 | `github.com` / `api.github.com` 均 200 |
| 自检 | 25 套全 PASS |

## 执行

```powershell
cd J:\plugin\dsh-session-live
pwsh -File scripts\publish.ps1
```

脚本会做六件事，每一步失败即停并打印真实原因：

1. **确认身份** —— 用 GCM 换到 token，调 `GET /user` 拿到真实 login，写进 `package.json` 的 `repository` / `bugs` / `homepage`（如果与占位 `lilcandi` 不同）。
2. **建仓库** —— `POST /user/repos`，`name=dsh-session-live`, `private=false`。已存在则跳过，不报错。
3. **推送** —— `git push -u origin main`，走 GCM。
4. **打 tag 并推** —— `git tag -a v1.0.0`，`git push origin v1.0.0`。
5. **建 Release** —— `POST /repos/{owner}/dsh-session-live/releases`，正文取 `CHANGELOG.md` 的 `## 1.0.0` 段落。
6. **生成市场索引** —— 写 `dist/index.json`，`source` 用 `{type:"git", url, commit:<真实40位SHA>}`。

## 手动分步（不想跑脚本时）

```powershell
cd J:\plugin\dsh-session-live

# 1. 触发 GCM 授权（浏览器弹窗，登录你的 GitHub 账号）
git ls-remote https://github.com/OWNER/dsh-session-live.git

# 2. 建仓库（用 GCM 存下的凭据，或手动填 PAT）
#    curl: POST https://api.github.com/user/repos  {"name":"dsh-session-live","private":false}
#    更简单：浏览器打开 https://github.com/new 手建空仓库

# 3. 推送
git remote add origin https://github.com/OWNER/dsh-session-live.git
git push -u origin main

# 4. tag
git tag -a v1.0.0 -m "dsh-session-live 1.0.0"
git push origin v1.0.0

# 5. Release：浏览器打开仓库 → Releases → Draft a new release → 选 v1.0.0
```

## 市场索引格式

`source` **只接受** `npm` 或 `git` 两种。git 源必须写**固定 40 位 commit SHA**，不能写分支名：

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "id": "dsh-session-live",
      "name": "会话实时预览",
      "description": "Hover a session row to see what it is doing right now, how much it spent, and the image it touched last.",
      "versions": [
        {
          "version": "1.0.0",
          "publishTimestamp": 1789600000000,
          "source": {
            "type": "git",
            "url": "https://github.com/OWNER/dsh-session-live.git",
            "commit": "0000000000000000000000000000000000000000"
          }
        }
      ]
    }
  ]
}
```

## npm 这条腿

本机 `registry.npmjs.org` SSL 直连失败（宿主的 node fetch 不读系统代理），且 `npm whoami` 是 `ENEEDAUTH`。
要发 npm 得先单独给 npm 配代理：

```powershell
npm config set proxy http://127.0.0.1:PORT
npm config set https-proxy http://127.0.0.1:PORT
npm whoami          # 应返回你的用户名，否则先 npm login
npm publish --access public
```

npm 通了以后，市场索引的 `source` 换成 `{"type":"npm","package":"dsh-session-live"}`，比 git 源省事。
