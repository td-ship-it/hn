# Điểm danh Hội nghị VC-NLĐ Trường Dược 2026 (Cloudflare Workers)

```
public/index.html   Màn hình kiosk nhập số điện thoại  (đường dẫn /)
public/admin.html   Đăng nhập + thống kê admin          (đường dẫn /admin)
src/worker.js       Worker: phục vụ giao diện + API
wrangler.toml       Cấu hình Cloudflare
apps-script/Code.gs API đọc/ghi Google Sheet + gửi mail (dán vào Apps Script của Sheet)
```

Luồng: Kiosk/Admin → Cloudflare Worker (kiểm tra mật khẩu admin) → Apps Script → Google Sheet + Gmail.

## Bước 1. Apps Script (backend)
1. Mở Google Sheet → Tiện ích mở rộng → Apps Script, dán `apps-script/Code.gs`.
2. Đổi `API_SECRET` thành chuỗi ngẫu nhiên dài (ví dụ 32 ký tự), ghi lại để dùng ở bước 2.
3. Chạy hàm `setup` một lần, cấp quyền (Sheet + gửi mail).
4. Triển khai → Tùy chọn triển khai mới → Ứng dụng web: Thực thi bằng **Tôi**, quyền truy cập **Bất kỳ ai**. Sao chép URL kết thúc bằng `/exec`.
   Khi sửa Code.gs về sau phải chọn "Quản lý bản triển khai → Sửa → Phiên bản mới".

## Bước 2. Cloudflare
```
npm i -g wrangler        # hoặc dùng npx wrangler
wrangler login
wrangler secret put ADMIN_PASSWORD   # nhập: Ump@2026
wrangler secret put GAS_URL          # dán URL /exec ở bước 1
wrangler secret put GAS_SECRET       # dán đúng chuỗi API_SECRET
wrangler deploy
```
Có thể gắn tên miền riêng trong Cloudflare Dashboard → Workers → diemdanh-hoinghi-vcnld → Settings → Domains.

## Bước 3. Dữ liệu Sheet
Điền cột **Số điện thoại** và cột **Email** (cột Email được tạo sau khi chạy `setup`) cho từng người.
Cột **Link tài liệu**: dòng nào để trống sẽ dùng chung link đầu tiên trong cột.

## Dùng kiosk
Mở `/` trên máy kiosk, bấm "Toàn màn hình". Sau mỗi lượt, màn hình tự về trạng thái nhập sau vài giây.
