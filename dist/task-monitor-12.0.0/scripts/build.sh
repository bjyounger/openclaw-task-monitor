#!/bin/bash

# Task Monitor 预编译构建脚本
# 用于生成可直接分发的 .tgz 包

set -e

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

VERSION=$(node -p "require('./package.json').version")
PACKAGE_NAME="task-monitor-${VERSION}"
OUTPUT_DIR="dist"

echo "=== Task Monitor 构建脚本 ==="
echo "版本: $VERSION"
echo ""

# 清理旧构建
echo "1. 清理旧构建..."
rm -rf $OUTPUT_DIR
rm -f *.tgz

# 创建输出目录
mkdir -p $OUTPUT_DIR/$PACKAGE_NAME

# 复制必要文件
echo "2. 复制文件..."
cp -r lib $OUTPUT_DIR/$PACKAGE_NAME/
cp -r scripts $OUTPUT_DIR/$PACKAGE_NAME/
cp -r workspace-templates $OUTPUT_DIR/$PACKAGE_NAME/
mkdir -p $OUTPUT_DIR/$PACKAGE_NAME/state

# 复制配置文件
cp package.json $OUTPUT_DIR/$PACKAGE_NAME/
cp README.md $OUTPUT_DIR/$PACKAGE_NAME/
cp config.json $OUTPUT_DIR/$PACKAGE_NAME/
cp index.ts $OUTPUT_DIR/$PACKAGE_NAME/

# 创建版本文件
echo "{\"version\": \"${VERSION}\", \"buildTime\": \"$(date -Iseconds)\"}" > $OUTPUT_DIR/$PACKAGE_NAME/.version.json

# 打包
echo "3. 打包..."
cd $OUTPUT_DIR
tar -czf ../${PACKAGE_NAME}.tgz $PACKAGE_NAME
cd ..

# 计算 SHA256
echo "4. 计算校验和..."
sha256sum ${PACKAGE_NAME}.tgz > ${PACKAGE_NAME}.tgz.sha256

# 显示结果
echo ""
echo "=== 构建完成 ==="
echo "输出文件:"
ls -lh ${PACKAGE_NAME}.tgz*
echo ""
echo "文件列表:"
tar -tzf ${PACKAGE_NAME}.tgz | head -20
echo "..."
echo ""
echo "安装方法:"
echo "  wget https://github.com/bjyounger/openclaw-task-monitor/releases/download/v${VERSION}/${PACKAGE_NAME}.tgz"
echo "  tar -xzf ${PACKAGE_NAME}.tgz"
echo "  mv ${PACKAGE_NAME} ~/.openclaw/extensions/task-monitor"
echo ""
echo "注意: 需要在 OpenClaw 环境中运行（openclaw 作为 peerDependency）"
