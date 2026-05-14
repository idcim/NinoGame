import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 跟 Agent 的 logo 配色保持一致
        brand: {
          DEFAULT: "#1ea7c4",
          50: "#f0f9fb",
          100: "#d8f0f5",
          200: "#a8e0eb",
          300: "#6fc7d8",
          400: "#3eaec2",
          500: "#1ea7c4",
          600: "#1789a3",
          700: "#176e83",
          800: "#185b6c",
          900: "#194c5a",
        },
        accent: {
          DEFAULT: "#66c596",
          500: "#66c596",
          600: "#4eb280",
        },
        warn: {
          DEFAULT: "#d96a3c",
          500: "#d96a3c",
        },
        ink: {
          DEFAULT: "#1a3140",
          dim: "#6f8590",
          light: "#a9b9c3",
        },
        bg: {
          DEFAULT: "#f5f9fb",
          card: "#ffffff",
        },
        border: {
          DEFAULT: "#dbe5eb",
        },
      },
      fontFamily: {
        sans: [
          '"Microsoft YaHei UI"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          "system-ui",
          "sans-serif",
        ],
      },
      borderRadius: {
        card: "14px",
      },
      boxShadow: {
        card: "0 4px 18px rgba(0,0,0,0.08)",
      },
    },
  },
  plugins: [],
} satisfies Config;
