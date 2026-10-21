import JSZip from 'jszip'

/** Small valid sources with the same verifiable fact in each supported format. */
export async function policySamples() {
  const fact = 'Verification park subsidy is 2700 yuan.'
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${fact}</w:t></w:r></w:p></w:body></w:document>`)
  const docx = await zip.generateAsync({ type: 'nodebuffer' })
  function pdf(text: string) {
    const stream = text ? `BT /F1 12 Tf 50 750 Td (${text}) Tj ET` : ''
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ]
    let content = '%PDF-1.4\n'
    const offsets: number[] = []
    objects.forEach((object, index) => {
      offsets.push(Buffer.byteLength(content))
      content += `${index + 1} 0 obj\n${object}\nendobj\n`
    })
    const xref = Buffer.byteLength(content)
    content += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return Buffer.from(content)
  }
  return { fact, files: [
    { name: 'policy.txt', content: Buffer.from(fact) },
    { name: 'policy.md', content: Buffer.from(`# Policy\n${fact}`) },
    { name: 'policy.markdown', content: Buffer.from(`# Policy\n${fact}`) },
    { name: 'policy.docx', content: docx },
    { name: 'policy.pdf', content: pdf(fact) },
  ], blankPdf: pdf('') }
}
