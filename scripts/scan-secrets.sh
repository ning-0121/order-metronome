#!/bin/sh
# scan-secrets.sh —— 提交前扫描暂存内容里的密钥/凭证,命中即阻断。
# 背景:仓库公开 + 生产在用,任何密钥一旦提交=对全世界泄露。本地这道闸挡住"手滑粘 key"。
# 误报可用  git commit --no-verify  临时绕过(慎用)。
set -e

# 1) 禁止提交 .env / 私钥文件本身
staged_files=$(git diff --cached --name-only --diff-filter=ACM)
bad_files=$(printf '%s\n' "$staged_files" | grep -Ei '(^|/)\.env($|\.)|\.pem$|\.p12$|\.pfx$|(^|/)id_rsa|(^|/)\.vercel/' || true)
if [ -n "$bad_files" ]; then
  echo "❌ 拒绝提交:检测到密钥/环境文件被加入暂存区:"
  printf '   %s\n' "$bad_files"
  echo "   → 这些文件绝不能进 git(公开仓库=全世界可见)。请 git rm --cached 后加进 .gitignore。"
  exit 1
fi

# 2) 扫描暂存的新增行内容(只看 +,不扫上下文/删除行)
added=$(git diff --cached --no-color -U0 --diff-filter=ACM | grep -E '^\+' | grep -Ev '^\+\+\+' || true)
[ -z "$added" ] && exit 0

# 高信号密钥指纹(命中基本就是真泄露)
patterns='(-----BEGIN[A-Z ]*PRIVATE KEY-----)|(eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,})|(gh[pousr]_[A-Za-z0-9]{30,})|(github_pat_[A-Za-z0-9_]{50,})|(sk-(ant-)?[A-Za-z0-9_-]{20,})|(AKIA[0-9A-Z]{16})|(xox[baprs]-[A-Za-z0-9-]{10,})'

hits=$(printf '%s\n' "$added" | grep -EnI "$patterns" || true)

# 3) 密钥类变量被赋"字面值"(排除 process.env / 占位空值 / 模板变量)
assign=$(printf '%s\n' "$added" \
  | grep -EiI '(SERVICE_ROLE_KEY|SMTP_PASS(WORD)?|_SECRET|_TOKEN|API_?KEY|ANON_KEY|PASSWORD)[A-Z_]*["'\'' ]*[:=][^=]' \
  | grep -EivI 'process\.env|import\.meta\.env|=\s*["'\'']?\s*["'\'']?\s*$|=\s*["'\'']?(your|xxx|placeholder|changeme|<|\$\{|env\.)' \
  | grep -EI '[:=]\s*["'\''][^"'\'' ]{8,}' || true)

if [ -n "$hits" ] || [ -n "$assign" ]; then
  echo "❌ 拒绝提交:暂存内容里疑似含密钥/凭证——"
  [ -n "$hits" ] && { echo "   [密钥指纹命中]"; printf '%s\n' "$hits" | sed 's/^/     /' | cut -c1-160; }
  [ -n "$assign" ] && { echo "   [密钥变量被赋字面值]"; printf '%s\n' "$assign" | sed 's/^/     /' | cut -c1-160; }
  echo ""
  echo "   → 密钥只能走环境变量(process.env.XXX)+ Vercel/本地 .env.local,绝不进代码。"
  echo "   → 确属误报可用:  git commit --no-verify"
  exit 1
fi

exit 0
