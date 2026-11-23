import { message, type SpokenLanguage } from './commandLanguage.js'
import type { CabinOrderResult } from './orders.js'
import type { CabinOrder, CabinOrderCancellationCandidate } from './types.js'

type OrderWords = { created:string; cancelled:string; empty:string; list:string; choose:string; drink:string; items:[string,string,string,string] }
const words: Record<Exclude<SpokenLanguage,'zh'>, OrderWords> = {
  en:{ created:'Your order has been placed.', cancelled:'Your order has been cancelled.', empty:'No matching orders were found.', list:'Your orders:', choose:'Which order would you like to cancel?', drink:'Which drink would you like?', items:['Blanket','Cola','Fresh orange juice','Jasmine latte'] },
  de:{ created:'Ihre Bestellung wurde aufgegeben.', cancelled:'Ihre Bestellung wurde storniert.', empty:'Es wurden keine passenden Bestellungen gefunden.', list:'Ihre Bestellungen:', choose:'Welche Bestellung möchten Sie stornieren?', drink:'Welches Getränk möchten Sie?', items:['Decke','Cola','Orangensaft','Jasmin-Latte'] },
  ja:{ created:'ご注文を受け付けました。', cancelled:'ご注文を取り消しました。', empty:'該当するご注文はありません。', list:'ご注文一覧：', choose:'どの注文を取り消しますか。', drink:'どのお飲み物にしますか。', items:['毛布','コーラ','オレンジジュース','ジャスミンラテ'] },
  ko:{ created:'주문이 접수되었습니다.', cancelled:'주문이 취소되었습니다.', empty:'해당 주문이 없습니다.', list:'주문 목록:', choose:'어떤 주문을 취소하시겠습니까?', drink:'어떤 음료를 원하시나요?', items:['담요','콜라','오렌지 주스','재스민 라테'] },
  fr:{ created:'Votre commande a été passée.', cancelled:'Votre commande a été annulée.', empty:'Aucune commande correspondante.', list:'Vos commandes :', choose:'Quelle commande souhaitez-vous annuler ?', drink:'Quelle boisson souhaitez-vous ?', items:['Couverture','Cola','Jus d’orange','Latte au jasmin'] },
  es:{ created:'Se ha realizado su pedido.', cancelled:'Se ha cancelado su pedido.', empty:'No se encontraron pedidos coincidentes.', list:'Sus pedidos:', choose:'¿Qué pedido desea cancelar?', drink:'¿Qué bebida desea?', items:['Manta','Refresco de cola','Zumo de naranja','Latte de jazmín'] },
  pt:{ created:'O seu pedido foi registado.', cancelled:'O seu pedido foi cancelado.', empty:'Não há pedidos correspondentes.', list:'Os seus pedidos:', choose:'Que pedido deseja cancelar?', drink:'Que bebida deseja?', items:['Cobertor','Refrigerante de cola','Sumo de laranja','Latte de jasmim'] },
  it:{ created:'Il suo ordine è stato registrato.', cancelled:'Il suo ordine è stato annullato.', empty:'Nessun ordine corrispondente.', list:'I suoi ordini:', choose:'Quale ordine desidera annullare?', drink:'Quale bevanda desidera?', items:['Coperta','Cola','Succo d’arancia','Latte al gelsomino'] },
  ru:{ created:'Ваш заказ оформлен.', cancelled:'Ваш заказ отменён.', empty:'Подходящих заказов нет.', list:'Ваши заказы:', choose:'Какой заказ вы хотите отменить?', drink:'Какой напиток вы хотите?', items:['Плед','Кола','Апельсиновый сок','Латте с жасмином'] },
}

const creationDisabled: Record<Exclude<SpokenLanguage, 'zh'>, string> = {
  en: 'Automatic ordering is paused. No order was placed. Please ask a flight attendant.',
  de: 'Automatische Bestellungen sind pausiert. Es wurde nichts bestellt. Bitte wenden Sie sich an das Kabinenpersonal.',
  ja: '自動注文は休止中です。注文はされていません。客室乗務員にお声がけください。',
  ko: '자동 주문이 일시 중지되었습니다. 주문이 접수되지 않았습니다. 승무원에게 문의해 주세요.',
  fr: 'Les commandes automatiques sont suspendues. Aucune commande passée. Veuillez vous adresser au personnel de cabine.',
  es: 'Los pedidos automáticos están en pausa. No se ha realizado ningún pedido. Consulte a la tripulación.',
  pt: 'Os pedidos automáticos estão suspensos. Não foi feito nenhum pedido. Fale com a tripulação.',
  it: 'Gli ordini automatici sono sospesi. Nessun ordine è stato effettuato. Si rivolga al personale di cabina.',
  ru: 'Автоматический заказ приостановлен. Заказ не оформлен. Обратитесь к бортпроводнику.',
}

export function orderReply(language: Exclude<SpokenLanguage,'zh'>, result: CabinOrderResult): string {
  const labels = words[language]
  const slots = result.slots
  if (slots.reason === 'creation_disabled') return creationDisabled[language]
  if (slots.execution_status === 'failed') return message(language,'failed')
  if (slots.execution_status === 'not_found') return labels.empty
  if (slots.execution_status === 'clarification_required') return `${labels.drink} ${labels.items.slice(1).join(', ')}`
  if (slots.execution_status === 'confirmation_required') {
    const candidates = slots.candidates as CabinOrderCancellationCandidate[]
    return `${labels.choose}\n${candidates.map((item,index) => `${index + 1}. ${item.orderNo || item.orderId}`).join('\n')}`
  }
  if (slots.execution_status !== 'succeeded') return message(language,'clarify')
  if (result.intent === 'service_order_create') {
    const items = slots.service_type_id === 1 ? [0] : slots.sub_item_ids as number[]
    return `${labels.created} ${items.map((item,index) => `${labels.items[item]} × ${(slots.quantities as number[])[index] ?? 1}`).join(', ')}`
  }
  if (result.intent === 'service_order_cancel') return labels.cancelled
  const orders = slots.orders as CabinOrder[]
  return orders?.length ? `${labels.list}\n${orders.map((order,index) => `${index+1}. ${[order.orderNo || order.id,order.status,order.createTime].filter(Boolean).join(' · ')}`).join('\n')}` : labels.empty
}

export function orderChoice(text: string, candidates: CabinOrderCancellationCandidate[]): string | undefined {
  const clean = text.normalize('NFKC').trim().replace(/[.!。！]$/u, '')
  const number = candidates.findIndex(item => clean === item.orderNo || clean === item.orderId)
  if (number >= 0) return `第${number+1}笔`
  const match = /^(?:(?:number|numéro|nummer|número|numero|номер)\s+|#)?(\d{1,2})(?:番|번)?$/iu.exec(clean)
  const index = match ? Number(match[1]) : 0
  return index > 0 && index <= candidates.length ? `第${index}笔` : undefined
}
