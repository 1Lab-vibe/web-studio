# 1Lab Web Studio: промпты для визуальной сборки сайта

Эти промпты предназначены для внутренней генерации визуальной версии сайта и клиентского кабинета. В публичном интерфейсе нельзя упоминать внутренние инструменты производства, поставщиков моделей, кодогенераторы, репозитории и технические детали сборки.

## Главный промпт

```text
Create a premium Russian website and customer account interface for “1Lab Web Studio”.

Business meaning:
1Lab Web Studio builds websites for small and local businesses. The studio gives the client a first working preview, then the client can continue editing and improving the site through a simple dialogue in a personal account. The site must feel like a real product, not a marketing placeholder.

Language:
Russian only. Use polished Russian UI copy. Do not mention implementation vendors, AI model names, internal generators, code hosting, or hidden automation providers.

Visual style:
Precise, confident, modern, editorial SaaS/product studio. Clean light interface, strong typography, restrained black/teal accent, no generic startup purple gradients, no decorative blobs, no fake crypto-style dashboards. The first viewport must immediately show the product: a live website preview plus a chat-based editing panel.

Pages/states:
1. Public landing page at webstudio.1true.ru.
2. Customer cabinet at /cabinet.
3. Admin cabinet entry point at /admin_cabinet as a private operator area link only.

Landing page sections:
- First viewport: “Сайт, который можно развивать диалогом”, supporting copy, CTA “Начать проект”, secondary CTA “Посмотреть процесс”, product mockup with website preview and editing dialogue.
- Process: registration and legal consent, brief from messages, first preview, payment and revisions.
- Customer cabinet showcase: preview, payment, revision dialogue, legal documents.
- Pricing: “Старт от 30 000 ₽ за сайт-визитку”, explain final price depends on pages, integrations and content.
- Legal trust: links to privacy policy, personal data consent, marketing consent, offer, disclaimer.
- Final CTA to register.

Customer cabinet functionality:
- Registration form: name, business name, email, phone, project goal.
- Two explicit consent checkboxes: personal data consent is required; marketing consent is optional.
- Email verification code screen.
- Project list.
- Preview panel with iframe-like website preview.
- Payment block with “Получить счет” / “Оплатить”.
- Brief dialogue form: client can describe site requirements and approve the brief.
- Revision dialogue form: client can request changes after payment.
- Status labels for preview, payment, revision queue.

Design requirements:
- Mobile-first responsive behavior.
- Cards max 8px radius unless a large product mockup uses a slightly larger radius.
- Buttons must look like real product controls.
- No landing-page filler, no fake generic metrics, no vague “AI-powered” buzzwords.
- Use real Russian product copy and practical business wording.
- Keep legal links visible in footer and registration.
- Make it feel trustworthy for Russian business clients.
```

## Промпт для клиентского кабинета

```text
Design the /cabinet customer account for 1Lab Web Studio in Russian.

The user has registered and verified email. Show:
- left project list;
- main project header with business name and current status;
- preview iframe area;
- payment action;
- brief submission dialogue;
- revision request dialogue;
- compact legal/document links.

Tone:
calm, product-like, clear, no technical jargon. The client should understand what to do next in under 10 seconds.

Functional states:
- no preview yet: “Превью появится здесь”.
- preview ready: show preview frame and payment action.
- payment required for revisions.
- revision queued.
- payment paid.
```

## Промпт для мобильной версии

```text
Create mobile responsive screens for 1Lab Web Studio:
1. Landing first viewport.
2. Registration form.
3. Email code screen.
4. Customer cabinet project page.

Use the same brand system as desktop: light background, black primary buttons, restrained teal accents, clear typography, no decorative clutter. Text must fit without overlaps.
```
