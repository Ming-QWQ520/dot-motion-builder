/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: the whole app is a client-side local-first editor,
  // so we can emit plain HTML/CSS/JS into ./out and embed it into the Go binary.
  output: "export",
  devIndicators: false,
  reactStrictMode: true,
  trailingSlash: true
};

export default nextConfig;
