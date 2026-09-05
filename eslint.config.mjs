import next from 'eslint-config-next'

// El proyecto no tenía ninguna configuración de ESLint: no había .eslintrc ni
// eslint.config.*, y el script `pnpm lint` era `next lint`, un comando que Next 16
// eliminó. O sea que nunca corrió un linter sobre este código.
//
// Config plana (ESLint 9), que es lo que pide eslint-config-next@16.
const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'data/**',
      // Sondas de un solo uso: se escriben para responder una pregunta y se tiran.
      // Que no ensucien el reporte del código que sí se mantiene.
      'scripts/_*.ts',
    ],
  },
  ...next,
  {
    rules: {
      // ── Por qué esta regla queda en warn y no en error ────────────────────
      // `react-hooks/set-state-in-effect` marca los diez buscadores con debounce del
      // repo, todos por la misma línea: `if (q.length < 2) { setResultados([]); return }`.
      // Ese setState no es una cascada de renders — es el reset sincrónico del resultado
      // anterior cuando el usuario borra lo que había escrito, y sin él la lista vieja
      // queda en pantalla contra una búsqueda que ya no existe.
      //
      // En error, `pnpm lint` termina siempre en rojo y deja de servir como control: los
      // avisos que sí importan quedan enterrados entre diez que no. En warn siguen a la
      // vista para revisarlos de a uno cuando haya que migrar esos efectos.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
]

export default config
