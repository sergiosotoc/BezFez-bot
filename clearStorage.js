// clearStorage.js

/* se corre asi: node clearStorage.js */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

async function clearAllBuckets() {
  const { data: buckets, error } = await supabase.storage.listBuckets()
  if (error) {
    console.error('Error al listar buckets:', error)
    return
  }

  if (!buckets || buckets.length === 0) {
    console.log('No hay buckets en Storage.')
    return
  }

  for (const bucket of buckets) {
    console.log(`Eliminando bucket: ${bucket.name}`)
    const emptyRes = await supabase.storage.emptyBucket(bucket.name)
    if (emptyRes?.error) {
      console.error(`Error al vaciar ${bucket.name}:`, emptyRes.error)
      continue
    }
    const delRes = await supabase.storage.deleteBucket(bucket.name)
    if (delRes?.error) {
      console.error(`Error al eliminar ${bucket.name}:`, delRes.error)
      continue
    }
    console.log(`Bucket ${bucket.name} eliminado correctamente`)
  }

  console.log('✅ Todos los buckets de Storage han sido eliminados')
}

clearAllBuckets()
