import { NextRequest, NextResponse } from 'next/server'

export function middleware(request: NextRequest) {
  const authHeader = request.headers.get('authorization')

  if (!authHeader?.startsWith('Basic ')) {
    return new NextResponse('Autenticacion requerida', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Bajaj Repuestos Admin"',
      },
    })
  }

  const encoded = authHeader.split(' ')[1]
  const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
  const colonIndex = decoded.indexOf(':')
  const user = decoded.slice(0, colonIndex)
  const pass = decoded.slice(colonIndex + 1)

  const validUser = process.env.ADMIN_USER ?? 'admin'
  const validPass = process.env.ADMIN_PASSWORD ?? 'admin123'

  if (user !== validUser || pass !== validPass) {
    return new NextResponse('Credenciales invalidas', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Bajaj Repuestos Admin"',
      },
    })
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
