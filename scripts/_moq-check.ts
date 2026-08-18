import { db } from '../lib/db'
try { process.loadEnvFile() } catch {}

async function main() {
  const envio = await db.envio.findUnique({
    where: { id: 5 },
    select: { supplierId: true, supplier: { select: { name: true } }, lineas: { select: { productId: true, quantity: true, product: { select: { bajajCode: true, nameEs: true } } } } },
  })
  console.log('envío 5 · proveedor:', envio?.supplier?.name ?? '(ninguno)', `(id ${envio?.supplierId})`)
  for (const l of envio?.lineas ?? []) {
    const sp = envio!.supplierId
      ? await db.supplierPrice.findUnique({
          where: { productId_supplierId: { productId: l.productId, supplierId: envio!.supplierId! } },
          select: { priceUsd: true, moq: true },
        })
      : null
    console.log(`  ${l.product.bajajCode}  x${l.quantity}  ${l.product.nameEs} → moq ${sp?.moq ?? '(sin fila)'}`)
  }
}
main().finally(() => db.$disconnect())
