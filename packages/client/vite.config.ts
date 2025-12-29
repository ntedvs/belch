import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react-swc"
import { defineConfig } from "vite"

const config = defineConfig({
  plugins: [react(), tailwindcss()],
})

export default config
