/**
 * 让 TypeScript 认识静态资源导入。
 *
 * Vite 在构建时能处理 `import x from './a.ico'`，但 tsc 不知道这是什么 ——
 * 于是报 TS2307。构建能过、typecheck 不过，这类"只在一边报错"的问题很容易被忽略，
 * 直到有人单独跑 typecheck 才发现。
 *
 * 这里只声明我们**实际用到**的类型，不做 `declare module '*'` 那种大撒网 ——
 * 那会让所有拼错的导入路径都变成"合法"，等于把拼写错误也放行了。
 */
declare module '*.ico' {
  const src: string
  export default src
}
