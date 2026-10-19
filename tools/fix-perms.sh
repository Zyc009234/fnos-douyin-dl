#!/bin/bash
# Windows 上运行 fnpack 打出的包会丢失 cmd/ 脚本和 ui/index.cgi 的可执行权限，用这个脚本重新打包修正。
# 用法：bash tools/fix-perms.sh DouyinDL.fpk
set -e
FPK="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OPTS=(--owner=0 --group=0 --numeric-owner)

tar -xzf "$FPK" -C "$WORK"
cd "$WORK"

# 内层 app.tgz：普通文件 644、目录 755，index.cgi 755
mkdir appdir && tar -xzf app.tgz -C appdir
(
  cd appdir
  tar -cf ../app.tar "${OPTS[@]}" --mode=u=rwX,go=rX --exclude=ui/index.cgi $(ls -A)
  [ -f ui/index.cgi ] && tar -rf ../app.tar "${OPTS[@]}" --mode=0755 ui/index.cgi
)
gzip -9 -c app.tar > app.tgz
rm -rf appdir app.tar

# 外层：cmd/ 脚本 755
tar -cf out.tar "${OPTS[@]}" --mode=0644 app.tgz
tar -rf out.tar "${OPTS[@]}" --mode=0755 cmd
tar -rf out.tar "${OPTS[@]}" --mode=u=rwX,go=rX config ICON.PNG ICON_256.PNG manifest wizard
gzip -9 -c out.tar > "$FPK"
echo "fixed: $FPK"
