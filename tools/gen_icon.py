"""生成应用图标：蓝底圆角 + 白色数据库圆柱。"""
from PIL import Image, ImageDraw

SIZE = 1024
OUT = "/Users/lvruifeng/Documents/java/工作文档/mysql-studio-tauri/src-tauri/icons/icon.png"

# ---- 渐变背景（圆角矩形）----
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
bg = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
bd = ImageDraw.Draw(bg)
for y in range(SIZE):
    t = y / (SIZE - 1)
    r = int(0x5C + (0x15 - 0x5C) * t)
    g = int(0x93 + (0x45 - 0x93) * t)
    b = int(0xFF + (0xC4 - 0xFF) * t)
    bd.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=232, fill=255)
img.paste(bg, (0, 0), mask)

# ---- 顶部高光 ----
glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse([110, -430, 910, 400], fill=(255, 255, 255, 46))
img = Image.alpha_composite(img, glow)

d = ImageDraw.Draw(img)

# ---- 数据库圆柱（顶部椭圆 + 主体 + 底部椭圆）----
L, R = 330, 694
TOP_Y, BOT_Y = 286, 742
RY = 62
WHITE = (255, 255, 255, 255)

d.rectangle([L, TOP_Y + RY, R, BOT_Y - RY], fill=WHITE)
d.ellipse([L, TOP_Y, R, TOP_Y + 2 * RY], fill=WHITE)
d.ellipse([L, BOT_Y - 2 * RY, R, BOT_Y], fill=WHITE)

# 圆柱分层弧线（用背景色描边模拟镂空）
for y in (TOP_Y + 2 * RY + 92, TOP_Y + 2 * RY + 188):
    d.arc([L, y - RY, R, y + RY], 0, 180, fill=(0x33, 0x63, 0xD6, 255), width=16)

img.save(OUT, "PNG")
print("saved", OUT, img.size)
