import { message, type SpokenLanguage } from './commandLanguage.js'
import { orderItemDetails, type CabinOrderResult } from './orders.js'
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

type OrderLanguage = Exclude<SpokenLanguage, 'zh'>
const failures: Record<OrderLanguage, [string, string, string]> = {
  en: ['Unable to place your order. Please try again later.', 'Unable to retrieve your orders. Please try again later.', 'Unable to cancel your order. Please try again later.'],
  de: ['Die Bestellung konnte nicht aufgegeben werden. Bitte versuchen Sie es später erneut.', 'Ihre Bestellungen konnten nicht abgerufen werden.', 'Die Bestellung konnte nicht storniert werden.'],
  ja: ['注文を受け付けられませんでした。しばらくしてからお試しください。', '注文を確認できませんでした。しばらくしてからお試しください。', '注文を取り消せませんでした。しばらくしてからお試しください。'],
  ko: ['주문을 접수하지 못했습니다. 나중에 다시 시도해 주세요.', '주문을 조회하지 못했습니다.', '주문을 취소하지 못했습니다.'],
  fr: ['La commande n’a pas pu être passée.', 'Les commandes n’ont pas pu être consultées.', 'La commande n’a pas pu être annulée.'],
  es: ['No se pudo realizar el pedido.', 'No se pudieron consultar los pedidos.', 'No se pudo cancelar el pedido.'],
  pt: ['Não foi possível registar o pedido.', 'Não foi possível consultar os pedidos.', 'Não foi possível cancelar o pedido.'],
  it: ['Non è stato possibile effettuare l’ordine.', 'Non è stato possibile consultare gli ordini.', 'Non è stato possibile annullare l’ordine.'],
  ru: ['Не удалось оформить заказ.', 'Не удалось получить список заказов.', 'Не удалось отменить заказ.'],
}
const statuses: Record<OrderLanguage, [string, string, string, string, string]> = {
  en: ['Accepted', 'Being delivered', 'Delivered', 'Cancelled', 'Status unavailable'],
  de: ['Angenommen', 'In Zustellung', 'Zugestellt', 'Storniert', 'Status unbekannt'],
  ja: ['受付済み', 'お届け中', 'お届け済み', '取消済み', '状況不明'],
  ko: ['접수됨', '배송 중', '배송 완료', '취소됨', '상태 확인 불가'],
  fr: ['Acceptée', 'En cours de livraison', 'Livrée', 'Annulée', 'Statut indisponible'],
  es: ['Aceptado', 'En reparto', 'Entregado', 'Cancelado', 'Estado no disponible'],
  pt: ['Aceite', 'Em entrega', 'Entregue', 'Cancelado', 'Estado indisponível'],
  it: ['Accettato', 'In consegna', 'Consegnato', 'Annullato', 'Stato non disponibile'],
  ru: ['Принят', 'Доставляется', 'Доставлен', 'Отменён', 'Статус неизвестен'],
}

function localizedStatus(language: OrderLanguage, status?: string): string {
  // Translate an actual named status; never infer completion from an undocumented code.
  const index = ['已接单', '配送中', '已送达', '已取消'].indexOf(status ?? '')
  return statuses[language][index < 0 ? 4 : index]!
}

function localizedItems(language: OrderLanguage, items: Record<string, unknown>[], serviceTypeId?: string): string {
  return orderItemDetails(items, serviceTypeId).map(item => {
    const name = item.catalogId !== undefined ? words[language].items[item.catalogId]! : item.name
    const n = item.quantity
    if (!n) return name
    const singular = Number(n) === 1
    if (language === 'ja') return `${name}${n}${({ 条: '枚', 杯: '杯', 瓶: '本', 个: '個', 份: '人前' } as Record<string, string>)[item.unit ?? ''] ?? ''}`
    if (language === 'ko') return `${name} ${n}${({ 条: '장', 杯: '잔', 瓶: '병', 个: '개', 份: '인분' } as Record<string, string>)[item.unit ?? ''] ?? ''}`
    if (item.catalogId === 0 && item.unit === '条') {
      const blanket = { en: ['blanket', 'blankets'], de: ['Decke', 'Decken'], fr: ['couverture', 'couvertures'],
        es: ['manta', 'mantas'], pt: ['cobertor', 'cobertores'], it: ['coperta', 'coperte'], ru: ['плед', 'пледа'] }[language]
      if (language !== 'ru') return `${n} ${blanket[singular ? 0 : 1]}`
    }
    if (item.unit === '杯' || item.unit === '瓶') {
      const units = item.unit === '杯'
        ? { en: ['cup of', 'cups of'], de: ['Becher', 'Becher'], fr: ['verre de', 'verres de'], es: ['vaso de', 'vasos de'], pt: ['copo de', 'copos de'], it: ['bicchiere di', 'bicchieri di'], ru: ['чашка', 'чашки'] }
        : { en: ['bottle of', 'bottles of'], de: ['Flasche', 'Flaschen'], fr: ['bouteille de', 'bouteilles de'], es: ['botella de', 'botellas de'], pt: ['garrafa de', 'garrafas de'], it: ['bottiglia di', 'bottiglie di'], ru: ['бутылка', 'бутылки'] }
      if (language !== 'ru') return `${n} ${units[language][singular ? 0 : 1]} ${name}`
    }
    return `${name}: ${n}`
  }).join(', ')
}

export function orderReply(language: Exclude<SpokenLanguage,'zh'>, result: CabinOrderResult): string {
  const labels = words[language]
  const slots = result.slots
  if (slots.reason === 'creation_disabled') return creationDisabled[language]
  if (slots.execution_status === 'failed') return failures[language][result.intent === 'service_order_create' ? 0 : result.intent === 'service_order_query' ? 1 : 2]
  if (slots.execution_status === 'not_found') return labels.empty
  if (slots.execution_status === 'clarification_required') return `${labels.drink} ${labels.items.slice(1).join(', ')}`
  if (slots.execution_status === 'confirmation_required') {
    const candidates = slots.candidates as CabinOrderCancellationCandidate[]
    return `${labels.choose}\n${candidates.map((item,index) => `${index + 1}. ${[localizedItems(language, item.items, item.serviceTypeId), item.createTime, item.orderNo].filter(Boolean).join(' · ')}`).join('\n')}`
  }
  if (slots.execution_status !== 'succeeded') return message(language,'clarify')
  if (result.intent === 'service_order_create') {
    const ids = slots.service_type_id === 1 ? [0] : slots.sub_item_ids as number[]
    const items = ids.map((id, index) => ({ subItemId: id, quantity: (slots.quantities as number[])[index] }))
    return `${labels.created} ${localizedItems(language, items, String(slots.service_type_id))}`
  }
  if (result.intent === 'service_order_cancel') return `${labels.cancelled}${Array.isArray(slots.items) ? ` ${localizedItems(language, slots.items, String(slots.service_type_id))}` : ''}`
  const orders = slots.orders as CabinOrder[]
  return orders?.length ? `${labels.list}\n${orders.map((order,index) => `${index+1}. ${[localizedItems(language, order.items, order.serviceTypeId), localizedStatus(language, order.statusName), order.createTime, order.orderNo].filter(Boolean).join(' · ')}`).join('\n')}` : labels.empty
}

export function orderChoice(text: string, candidates: CabinOrderCancellationCandidate[]): string | undefined {
  const clean = text.normalize('NFKC').trim().replace(/[.!。！]$/u, '')
  const number = candidates.findIndex(item => clean === item.orderNo || clean === item.orderId)
  if (number >= 0) return `第${number+1}笔`
  const match = /^(?:(?:number|numéro|nummer|número|numero|номер)\s+|#)?(\d{1,2})(?:番|번)?$/iu.exec(clean)
  const index = match ? Number(match[1]) : 0
  return index > 0 && index <= candidates.length ? `第${index}笔` : undefined
}
