module scoutpad/desktop

go 1.26.7

require moorebot-scout/mobilebridge v0.0.0

require (
	github.com/aler9/goroslib v0.0.0-20220831065204-cd7cf8973f37 // indirect
	github.com/gookit/color v1.5.0 // indirect
	github.com/xo/terminfo v0.0.0-20210125001918-ca9a967f8778 // indirect
	golang.org/x/sys v0.47.0 // indirect
	moorebot-scout/bridge v0.0.0 // indirect
)

replace moorebot-scout/mobilebridge => ../mobilebridge

replace moorebot-scout/bridge => ..
