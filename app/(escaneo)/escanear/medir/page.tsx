import Medir from './Medir'
import { piezaParaMedir } from './actions'

export const metadata = { title: 'Medir' }

// `?id=` abre una pieza directo (el botón Medir de Consultar).
export default async function MedirPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const id = Number((await searchParams).id)
  return <Medir inicial={Number.isInteger(id) && id > 0 ? await piezaParaMedir(id) : null} />
}
