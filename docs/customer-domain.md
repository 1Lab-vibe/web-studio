# Customer Domain Publishing

Default preview:

```text
https://webstudio.1true.ru/projects/<project-slug>/
```

## What the customer does

1. Buy a domain at any registrar.
2. Open DNS settings for the domain.
3. Add or update these records:

```text
@      A      147.45.96.77
www    A      147.45.96.77
```

4. Remove old `A`, `AAAA` or `CNAME` records for `@` and `www` if they point to another website.
5. Send the domain name to Web Studio after saving DNS.

DNS usually updates in 5-60 minutes, but some registrars can take up to 24 hours.

## What Web Studio does

1. Map the customer domain to the project slug.
2. Add the domain to the reverse proxy/Timeweb publishing configuration.
3. Issue Let's Encrypt SSL through Traefik.
4. Verify:

```text
https://customer-domain.ru
https://www.customer-domain.ru
```

## v1 limits

The app currently publishes every generated site under `/projects/<slug>`. Custom customer domains are an operations step: after DNS points to `147.45.96.77`, add the domain to Traefik/Timeweb and route it to the matching project.
