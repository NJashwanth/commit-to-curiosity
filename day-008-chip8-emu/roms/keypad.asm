; Keypad test, written by Jashwanth Neela for Day 008 of commit-to-curiosity.
; Press and release any key: its hex digit appears in the box with a beep.
; Handy for checking the keyboard mapping and the touch keys.
; Build with: npm run roms

        LD   I, box
        LD   V1, 27
        LD   V2, 10
        DRW  V1, V2, 11         ; the frame around the digit
        LD   V1, 29             ; digit position: centred inside the frame
        LD   V2, 13
        LD   V4, 0xFF           ; 0xFF = no digit on screen yet

loop:
        LD   V0, K              ; wait for a key press and release
        SE   V4, 0xFF
        CALL draw_digit         ; erase the previous digit
        LD   V4, V0
        CALL draw_digit         ; draw the new one
        LD   V3, 4
        LD   ST, V3             ; short beep
        JP   loop

draw_digit:
        LD   F, V4
        DRW  V1, V2, 5
        RET

box:
        DB 0xFF, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xFF
