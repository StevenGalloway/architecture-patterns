FROM openresty/openresty:1.25.3.1-alpine

# Install redis lua client and limit traffic lib (OpenResty packages)
RUN /usr/local/openresty/bin/opm get openresty/lua-resty-redis &&     /usr/local/openresty/bin/opm get openresty/lua-resty-limit-traffic

COPY nginx.conf /etc/nginx/nginx.conf
COPY lua /etc/nginx/lua
