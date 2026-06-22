#!/bin/bash


# 切换到脚本所在目录(确保在 agent 目录下执行)
cd "$(dirname "$0")"

OUT_DIR="out"
mkdir -p "$OUT_DIR"

echo "清理旧的构建产物..."
rm -rf "$OUT_DIR"/*

echo "开始编译多端 agent，使用 Go 版本: $(go version)"

echo "正在下载依赖 (go mod tidy)..."
export GOPROXY=https://goproxy.cn,direct
go mod tidy

# 定义需要编译的平台: GOOS GOARCH 产物名
platforms=(
    "linux amd64 agent-linux-amd64"
    "linux 386 agent-linux-386"
    "linux arm64 agent-linux-arm64"
    "linux arm agent-linux-arm"
    "darwin amd64 agent-darwin-amd64"
    "darwin arm64 agent-darwin-arm64"
    "windows amd64 agent-windows-amd64.exe"
)

# 使用 -ldflags="-s -w" 和 -trimpath 减小体积并去掉绝对路径信息

for platform in "${platforms[@]}"; do
    read -r GOOS GOARCH OUTPUT_NAME <<< "$platform"
    echo "正在编译 $GOOS/$GOARCH -> $OUT_DIR/$OUTPUT_NAME ..."
    env GOOS=$GOOS GOARCH=$GOARCH go build -trimpath -ldflags="-s -w" -o "$OUT_DIR/$OUTPUT_NAME" main.go
    if [ $? -ne 0 ]; then
        echo "❌ 编译失败: $GOOS/$GOARCH"
        exit 1
    fi
done

echo "✅ 所有平台编译完成！产物输出在 $(pwd)/$OUT_DIR 目录:"
ls -lh "$OUT_DIR"
