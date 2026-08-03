/* Tailwind v4 runs as a PostCSS plugin, and `app/globals.css` opens with
   `@import "tailwindcss"`. Without this file that import is an unresolvable
   module specifier and the CSS graph fails to build — every component styled in
   Tailwind classes, and no Tailwind. */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
}

export default config
