import asyncio
import os
import random
import secrets
import string
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import chess
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import uvicorn

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Glass Chess")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def clean_name(name: str) -> str:
    name = " ".join((name or "Player").strip().split())
    return name[:24] or "Player"


def room_code(length: int = 6) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


class CreateRoomRequest(BaseModel):
    name: str = Field(default="Player", max_length=80)
    token: str = Field(min_length=8, max_length=120)
    minutes: int = Field(default=10, ge=1, le=60)
    mode: str = Field(default="pvp")
    difficulty: str = Field(default="medium")
    color: str = Field(default="white")


@dataclass
class Player:
    token: str
    name: str
    is_ai: bool = False


@dataclass
class Client:
    ws: WebSocket
    token: str
    name: str


@dataclass
class Room:
    code: str
    initial_seconds: float
    creator_token: str
    mode: str = "pvp"
    difficulty: str = "medium"
    white: Optional[Player] = None
    black: Optional[Player] = None
    board: chess.Board = field(default_factory=chess.Board)
    white_time: float = 600.0
    black_time: float = 600.0
    active_since: Optional[float] = None
    started: bool = False
    result: Optional[dict] = None
    draw_offer: Optional[str] = None
    rematch_votes: set[str] = field(default_factory=set)
    move_sans: list[str] = field(default_factory=list)
    move_uci: list[str] = field(default_factory=list)
    clients: list[Client] = field(default_factory=list)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    ticker: Optional[asyncio.Task] = None
    ai_thinking: bool = False

    def __post_init__(self):
        self.white_time = self.initial_seconds
        self.black_time = self.initial_seconds


rooms: dict[str, Room] = {}


def player_role(room: Room, token: str) -> str:
    if room.white and room.white.token == token:
        return "white"
    if room.black and room.black.token == token:
        return "black"
    return "spectator"


def is_connected(room: Room, token: str) -> bool:
    player = None
    if room.white and room.white.token == token:
        player = room.white
    elif room.black and room.black.token == token:
        player = room.black
    if player and player.is_ai:
        return True
    return any(c.token == token for c in room.clients)


def side_player(room: Room, color: str) -> Optional[Player]:
    return room.white if color == "white" else room.black


def ai_color(room: Room) -> Optional[str]:
    if room.white and room.white.is_ai:
        return "white"
    if room.black and room.black.is_ai:
        return "black"
    return None


def human_color(room: Room) -> Optional[str]:
    if room.mode != "ai":
        return None
    if room.white and not room.white.is_ai:
        return "white"
    if room.black and not room.black.is_ai:
        return "black"
    return None


def sync_clock(room: Room) -> bool:
    if not room.started or room.result or room.active_since is None:
        return False

    now = time.monotonic()
    elapsed = max(0.0, now - room.active_since)
    room.active_since = now

    if room.board.turn == chess.WHITE:
        room.white_time -= elapsed
        if room.white_time <= 0:
            room.white_time = 0
            room.result = {"winner": "black", "reason": "timeout", "message": "White ran out of time — Black wins."}
            room.active_since = None
            return True
    else:
        room.black_time -= elapsed
        if room.black_time <= 0:
            room.black_time = 0
            room.result = {"winner": "white", "reason": "timeout", "message": "Black ran out of time — White wins."}
            room.active_since = None
            return True
    return False


def termination_text(outcome: chess.Outcome) -> tuple[str, str]:
    labels = {
        chess.Termination.CHECKMATE: "checkmate",
        chess.Termination.STALEMATE: "stalemate",
        chess.Termination.INSUFFICIENT_MATERIAL: "insufficient material",
        chess.Termination.SEVENTYFIVE_MOVES: "75-move rule",
        chess.Termination.FIVEFOLD_REPETITION: "fivefold repetition",
    }
    reason = labels.get(outcome.termination, str(outcome.termination).split(".")[-1].replace("_", " ").lower())
    if outcome.winner is chess.WHITE:
        return reason, f"White wins — {reason}."
    if outcome.winner is chess.BLACK:
        return reason, f"Black wins — {reason}."
    return reason, f"Draw — {reason}."


def maybe_finish_from_board(room: Room) -> None:
    outcome = room.board.outcome(claim_draw=False)
    if not outcome:
        return
    reason, message = termination_text(outcome)
    winner = "white" if outcome.winner is chess.WHITE else "black" if outcome.winner is chess.BLACK else None
    room.result = {"winner": winner, "reason": reason, "message": message}
    room.active_since = None
    room.ai_thinking = False


def status_text(room: Room) -> str:
    if room.result:
        return room.result["message"]
    if room.mode == "pvp" and room.black is None:
        return "Waiting for an opponent to join…"
    if room.ai_thinking:
        return "Computer is thinking…"
    side = "White" if room.board.turn == chess.WHITE else "Black"
    return side + (" — Check!" if room.board.is_check() else " to move")


def legal_moves_for(room: Room, role: str) -> list[str]:
    if room.result or role not in ("white", "black"):
        return []
    player = side_player(room, role)
    if player and player.is_ai:
        return []
    expected = "white" if room.board.turn == chess.WHITE else "black"
    if role != expected or room.ai_thinking:
        return []
    return [m.uci() for m in room.board.legal_moves]


def snapshot(room: Room, token: str) -> dict:
    role = player_role(room, token)
    return {
        "type": "state",
        "room": room.code,
        "mode": room.mode,
        "difficulty": room.difficulty,
        "fen": room.board.fen(),
        "turn": "white" if room.board.turn == chess.WHITE else "black",
        "role": role,
        "status": status_text(room),
        "white": {
            "name": room.white.name if room.white else "White",
            "connected": bool(room.white and is_connected(room, room.white.token)),
            "ai": bool(room.white and room.white.is_ai),
        },
        "black": {
            "name": room.black.name if room.black else "Waiting…",
            "connected": bool(room.black and is_connected(room, room.black.token)),
            "ai": bool(room.black and room.black.is_ai),
        },
        "white_ms": max(0, round(room.white_time * 1000)),
        "black_ms": max(0, round(room.black_time * 1000)),
        "clock_running": bool(room.started and not room.result and room.active_since is not None),
        "moves": room.move_sans,
        "uci_moves": room.move_uci,
        "legal_moves": legal_moves_for(room, role),
        "draw_offer": room.draw_offer,
        "result": room.result,
        "rematch_votes": len(room.rematch_votes),
        "spectators": sum(1 for c in room.clients if player_role(room, c.token) == "spectator"),
        "ai_thinking": room.ai_thinking,
    }


async def safe_send(client: Client, payload: dict) -> bool:
    try:
        await client.ws.send_json(payload)
        return True
    except Exception:
        return False


async def broadcast(room: Room, event: Optional[dict] = None) -> None:
    dead: list[Client] = []
    for client in list(room.clients):
        payload = snapshot(room, client.token)
        if event:
            payload["event"] = event
        if not await safe_send(client, payload):
            dead.append(client)
    for client in dead:
        if client in room.clients:
            room.clients.remove(client)


PIECE_VALUES = {
    chess.PAWN: 100,
    chess.KNIGHT: 320,
    chess.BISHOP: 330,
    chess.ROOK: 500,
    chess.QUEEN: 900,
    chess.KING: 0,
}


def evaluate_board(board: chess.Board, ai_is_white: bool) -> int:
    if board.is_checkmate():
        winner_white = board.turn == chess.BLACK
        return 100000 if winner_white == ai_is_white else -100000
    if board.is_stalemate() or board.is_insufficient_material():
        return 0

    score = 0
    ai_color_bool = chess.WHITE if ai_is_white else chess.BLACK
    for piece_type, value in PIECE_VALUES.items():
        score += len(board.pieces(piece_type, ai_color_bool)) * value
        score -= len(board.pieces(piece_type, not ai_color_bool)) * value

    # Small positional bonuses make the engine less random without needing Stockfish.
    center = [chess.D4, chess.E4, chess.D5, chess.E5]
    for sq in center:
        piece = board.piece_at(sq)
        if piece:
            score += 18 if piece.color == ai_color_bool else -18
    if board.is_check():
        score += -25 if board.turn == ai_color_bool else 25
    return score


def minimax(board: chess.Board, depth: int, alpha: int, beta: int, ai_is_white: bool) -> int:
    if depth <= 0 or board.is_game_over(claim_draw=False):
        return evaluate_board(board, ai_is_white)

    ai_color_bool = chess.WHITE if ai_is_white else chess.BLACK
    maximizing = board.turn == ai_color_bool

    if maximizing:
        value = -10**9
        for move in board.legal_moves:
            board.push(move)
            value = max(value, minimax(board, depth - 1, alpha, beta, ai_is_white))
            board.pop()
            alpha = max(alpha, value)
            if alpha >= beta:
                break
        return value

    value = 10**9
    for move in board.legal_moves:
        board.push(move)
        value = min(value, minimax(board, depth - 1, alpha, beta, ai_is_white))
        board.pop()
        beta = min(beta, value)
        if alpha >= beta:
            break
    return value


def choose_ai_move(board: chess.Board, difficulty: str) -> Optional[chess.Move]:
    moves = list(board.legal_moves)
    if not moves:
        return None
    if difficulty == "easy":
        captures = [m for m in moves if board.is_capture(m)]
        pool = captures if captures and random.random() < 0.35 else moves
        return random.choice(pool)

    ai_is_white = board.turn == chess.WHITE
    depth = 1 if difficulty == "medium" else 2
    scored: list[tuple[int, chess.Move]] = []
    for move in moves:
        board.push(move)
        score = minimax(board, depth, -10**9, 10**9, ai_is_white)
        board.pop()
        scored.append((score, move))

    scored.sort(key=lambda item: item[0], reverse=True)
    if difficulty == "medium" and len(scored) > 1:
        # Medium occasionally chooses among near-best moves so it feels human.
        best = scored[0][0]
        near = [item for item in scored if item[0] >= best - 80][:4]
        return random.choice(near)[1]
    return scored[0][1]


async def perform_ai_move(room: Room) -> None:
    await asyncio.sleep(0.38)
    async with room.lock:
        if room.result or room.mode != "ai" or not room.started:
            room.ai_thinking = False
            return
        current_color = "white" if room.board.turn == chess.WHITE else "black"
        player = side_player(room, current_color)
        if not player or not player.is_ai:
            room.ai_thinking = False
            return
        sync_clock(room)
        if room.result:
            room.ai_thinking = False
            return
        room.ai_thinking = True
        board_copy = room.board.copy(stack=False)
        expected_fen = room.board.fen()
        difficulty = room.difficulty

    await broadcast(room, {"kind": "thinking"})
    move = await asyncio.to_thread(choose_ai_move, board_copy, difficulty)

    async with room.lock:
        if room.result or room.board.fen() != expected_fen:
            room.ai_thinking = False
            return
        sync_clock(room)
        if room.result or move is None or move not in room.board.legal_moves:
            room.ai_thinking = False
            maybe_finish_from_board(room)
            event = {"kind": "game_over"} if room.result else None
        else:
            captured = room.board.is_capture(move)
            san = room.board.san(move)
            room.board.push(move)
            room.move_sans.append(san)
            room.move_uci.append(move.uci())
            room.draw_offer = None
            room.ai_thinking = False
            room.active_since = time.monotonic() if room.started else None
            maybe_finish_from_board(room)
            event = {"kind": "game_over" if room.result else ("capture" if captured else "move"), "san": san}
    await broadcast(room, event)


async def ticker(room: Room) -> None:
    try:
        while room.code in rooms:
            await asyncio.sleep(1)
            async with room.lock:
                timed_out = sync_clock(room) if room.started and not room.result else False
            await broadcast(room, {"kind": "game_over"} if timed_out else None)
    except asyncio.CancelledError:
        pass


@app.get("/")
async def home():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/game/{code}")
async def game_page(code: str):
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health():
    return {"ok": True, "rooms": len(rooms)}


@app.post("/api/rooms")
async def create_room(data: CreateRoomRequest):
    mode = data.mode if data.mode in {"pvp", "ai"} else "pvp"
    difficulty = data.difficulty if data.difficulty in {"easy", "medium", "hard"} else "medium"
    color = data.color if data.color in {"white", "black", "random"} else "white"
    if color == "random":
        color = random.choice(["white", "black"])

    code = room_code()
    while code in rooms:
        code = room_code()

    human = Player(token=data.token, name=clean_name(data.name))
    if mode == "ai":
        bot = Player(token=f"__AI__:{code}", name=f"Nova AI · {difficulty.title()}", is_ai=True)
        white = human if color == "white" else bot
        black = bot if color == "white" else human
    else:
        white = human
        black = None

    room = Room(
        code=code,
        initial_seconds=float(data.minutes * 60),
        creator_token=data.token,
        mode=mode,
        difficulty=difficulty,
        white=white,
        black=black,
    )
    rooms[code] = room
    room.ticker = asyncio.create_task(ticker(room))
    return {"room": code, "url": f"/game/{code}"}


async def send_error(ws: WebSocket, message: str) -> None:
    try:
        await ws.send_json({"type": "error", "message": message})
    except Exception:
        pass


@app.websocket("/ws/{code}")
async def websocket_game(ws: WebSocket, code: str):
    code = code.upper()
    room = rooms.get(code)
    if not room:
        await ws.accept()
        await ws.send_json({"type": "error", "message": "This game room does not exist."})
        await ws.close(code=4404)
        return

    token = (ws.query_params.get("token") or "")[:120]
    name = clean_name(ws.query_params.get("name") or "Player")
    if len(token) < 8:
        await ws.accept()
        await ws.send_json({"type": "error", "message": "Invalid player token."})
        await ws.close(code=4400)
        return

    await ws.accept()
    client = Client(ws=ws, token=token, name=name)
    start_ai = False

    async with room.lock:
        old = [c for c in room.clients if c.token == token]
        for c in old:
            room.clients.remove(c)
            try:
                await c.ws.close(code=4001)
            except Exception:
                pass

        if room.white and room.white.token == token:
            room.white.name = name
        elif room.black and room.black.token == token:
            room.black.name = name
        elif room.mode == "pvp" and room.black is None:
            room.black = Player(token=token, name=name)

        room.clients.append(client)

        if not room.started and not room.result:
            if room.mode == "ai":
                hc = human_color(room)
                human = side_player(room, hc) if hc else None
                if human and is_connected(room, human.token):
                    room.started = True
                    room.active_since = time.monotonic()
                    start_ai = ai_color(room) == "white"
            elif room.white and room.black and is_connected(room, room.white.token) and is_connected(room, room.black.token):
                room.started = True
                room.active_since = time.monotonic()

    await broadcast(room, {"kind": "join"})
    if start_ai:
        asyncio.create_task(perform_ai_move(room))

    try:
        while True:
            data = await ws.receive_json()
            action = data.get("action")
            event: Optional[dict] = None
            trigger_ai = False

            try:
                async with room.lock:
                    role = player_role(room, token)
                    sync_clock(room)

                    if action == "move":
                        if room.result:
                            raise ValueError("The game is already finished.")
                        if role not in ("white", "black"):
                            raise ValueError("Spectators cannot move pieces.")
                        player = side_player(room, role)
                        if player and player.is_ai:
                            raise ValueError("The computer controls that side.")
                        expected = "white" if room.board.turn == chess.WHITE else "black"
                        if role != expected or room.ai_thinking:
                            raise ValueError("It is not your turn.")

                        from_sq = str(data.get("from", ""))
                        to_sq = str(data.get("to", ""))
                        promotion = str(data.get("promotion", "") or "").lower()
                        uci = from_sq + to_sq + promotion
                        try:
                            move = chess.Move.from_uci(uci)
                        except ValueError:
                            raise ValueError("Invalid move format.")
                        if move not in room.board.legal_moves:
                            raise ValueError("That move is not legal.")

                        captured = room.board.is_capture(move)
                        san = room.board.san(move)
                        room.board.push(move)
                        room.move_sans.append(san)
                        room.move_uci.append(uci)
                        room.draw_offer = None
                        room.rematch_votes.clear()
                        room.active_since = time.monotonic() if room.started else None
                        maybe_finish_from_board(room)
                        event = {"kind": "game_over" if room.result else ("capture" if captured else "move"), "san": san}
                        if room.mode == "ai" and not room.result:
                            next_color = "white" if room.board.turn == chess.WHITE else "black"
                            next_player = side_player(room, next_color)
                            trigger_ai = bool(next_player and next_player.is_ai)

                    elif action == "offer_draw":
                        if room.mode == "ai":
                            raise ValueError("Draw offers are only available in online games.")
                        if role not in ("white", "black") or room.result:
                            raise ValueError("You cannot offer a draw right now.")
                        room.draw_offer = role
                        event = {"kind": "draw_offer", "by": role}

                    elif action == "decline_draw":
                        if role not in ("white", "black"):
                            raise ValueError("Only players can decline a draw.")
                        if room.draw_offer and room.draw_offer != role:
                            room.draw_offer = None
                            event = {"kind": "draw_declined"}

                    elif action == "accept_draw":
                        if role not in ("white", "black"):
                            raise ValueError("Only players can accept a draw.")
                        if not room.draw_offer or room.draw_offer == role:
                            raise ValueError("There is no opponent draw offer to accept.")
                        room.result = {"winner": None, "reason": "agreed draw", "message": "Draw by agreement."}
                        room.active_since = None
                        room.draw_offer = None
                        event = {"kind": "game_over"}

                    elif action == "resign":
                        if role not in ("white", "black") or room.result:
                            raise ValueError("You cannot resign right now.")
                        winner = "black" if role == "white" else "white"
                        room.result = {"winner": winner, "reason": "resignation", "message": f"{role.title()} resigned — {winner.title()} wins."}
                        room.active_since = None
                        room.ai_thinking = False
                        event = {"kind": "game_over"}

                    elif action == "rematch":
                        if role not in ("white", "black") or not room.result:
                            raise ValueError("Rematch is available after the game ends.")
                        room.rematch_votes.add(token)

                        if room.mode == "ai":
                            room.white, room.black = room.black, room.white
                            room.board.reset()
                            room.white_time = room.initial_seconds
                            room.black_time = room.initial_seconds
                            room.result = None
                            room.draw_offer = None
                            room.rematch_votes.clear()
                            room.move_sans.clear()
                            room.move_uci.clear()
                            room.ai_thinking = False
                            room.started = True
                            room.active_since = time.monotonic()
                            trigger_ai = bool(room.white and room.white.is_ai)
                            event = {"kind": "rematch_started"}
                        else:
                            white_token = room.white.token if room.white else None
                            black_token = room.black.token if room.black else None
                            if white_token in room.rematch_votes and black_token in room.rematch_votes:
                                room.white, room.black = room.black, room.white
                                room.board.reset()
                                room.white_time = room.initial_seconds
                                room.black_time = room.initial_seconds
                                room.result = None
                                room.draw_offer = None
                                room.rematch_votes.clear()
                                room.move_sans.clear()
                                room.move_uci.clear()
                                room.ai_thinking = False
                                room.started = bool(room.white and room.black and is_connected(room, room.white.token) and is_connected(room, room.black.token))
                                room.active_since = time.monotonic() if room.started else None
                                event = {"kind": "rematch_started"}
                            else:
                                event = {"kind": "rematch_vote"}

                    elif action == "ping":
                        pass
                    else:
                        raise ValueError("Unknown action.")

                await broadcast(room, event)
                if trigger_ai:
                    asyncio.create_task(perform_ai_move(room))
            except ValueError as exc:
                await send_error(ws, str(exc))

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        async with room.lock:
            if client in room.clients:
                room.clients.remove(client)
        await broadcast(room, {"kind": "leave"})


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
