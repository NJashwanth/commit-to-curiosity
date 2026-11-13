; J N demo, written by Jashwanth Neela for Day 008 of commit-to-curiosity.
; Draws the initials "J N" and a divider, then bounces a ball underneath.
; The ball beeps when it hits a wall. Works under every quirk preset.
; Build with: npm run roms

        CLS
        LD   V1, 2              ; letters sit at y = 2
        LD   V0, 20
        LD   I, letter_j
        DRW  V0, V1, 9
        LD   V0, 36             ; an 8 pixel gap is the space in "J N"
        LD   I, letter_n
        DRW  V0, V1, 9

        ; Divider: eight 8-pixel segments across y = 13.
        LD   I, segment
        LD   V0, 0
        LD   V1, 13
divider:
        DRW  V0, V1, 1
        ADD  V0, 8
        SE   V0, 64
        JP   divider

        ; Ball state: V2 = x, V3 = y, V4 = dx, V5 = dy (0xFF means -1).
        LD   V2, 10
        LD   V3, 16
        LD   V4, 1
        LD   V5, 1
        LD   I, ball
        DRW  V2, V3, 4

loop:
        LD   V6, DT             ; wait for the delay timer: one move per tick
        SE   V6, 0
        JP   loop
        LD   V6, 1
        LD   DT, V6

        LD   I, ball
        DRW  V2, V3, 4          ; erase the ball (drawing again XORs it off)
        ADD  V2, V4             ; move
        ADD  V3, V5
        SNE  V2, 0              ; bounce off the four walls of the play area
        CALL hit_left
        SNE  V2, 60
        CALL hit_right
        SNE  V3, 15
        CALL hit_top
        SNE  V3, 28
        CALL hit_bottom
        DRW  V2, V3, 4          ; draw it in the new spot
        JP   loop

hit_left:
        LD   V4, 1
        JP   beep
hit_right:
        LD   V4, 0xFF
        JP   beep
hit_top:
        LD   V5, 1
        JP   beep
hit_bottom:
        LD   V5, 0xFF
beep:
        LD   V7, 3              ; three ticks of sound, 50ms
        LD   ST, V7
        RET

letter_j:
        DB 0b00111111
        DB 0b00111111
        DB 0b00000110
        DB 0b00000110
        DB 0b00000110
        DB 0b00000110
        DB 0b11000110
        DB 0b11000110
        DB 0b01111100
letter_n:
        DB 0b11000011
        DB 0b11100011
        DB 0b11110011
        DB 0b11011011
        DB 0b11001111
        DB 0b11000111
        DB 0b11000011
        DB 0b11000011
        DB 0b11000011
segment:
        DB 0b11111111
ball:
        DB 0b01100000
        DB 0b11110000
        DB 0b11110000
        DB 0b01100000
