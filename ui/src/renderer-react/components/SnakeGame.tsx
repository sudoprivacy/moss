import { useEffect, useRef, useState, useCallback } from 'react';

// === Types ===
interface Position {
  x: number;
  y: number;
}

enum Direction {
  UP = 'UP',
  DOWN = 'DOWN',
  LEFT = 'LEFT',
  RIGHT = 'RIGHT',
}

interface Snake {
  body: Position[];
}

interface Food {
  position: Position;
}

interface GameState {
  snake: Snake;
  food: Food;
  direction: Direction;
  score: number;
  isGameOver: boolean;
  isPlaying: boolean;
}

// === Constants ===
const GRID_SIZE = 20;
const CELL_SIZE = 20;
const CANVAS_SIZE = GRID_SIZE * CELL_SIZE;
const GAME_SPEED = 150;

const DIRECTION_VELOCITY: Record<Direction, Position> = {
  [Direction.UP]: { x: 0, y: -1 },
  [Direction.DOWN]: { x: 0, y: 1 },
  [Direction.LEFT]: { x: -1, y: 0 },
  [Direction.RIGHT]: { x: 1, y: 0 },
};

const COLOR_SNAKE = '#4ade80';
const COLOR_SNAKE_HEAD = '#22c55e';
const COLOR_FOOD = '#ef4444';
const COLOR_GRID = '#1e293b';
const COLOR_BACKGROUND = '#0f172a';

// === Helper Functions ===
const getOppositeDirection = (dir: Direction): Direction => {
  const opposites: Record<Direction, Direction> = {
    [Direction.UP]: Direction.DOWN,
    [Direction.DOWN]: Direction.UP,
    [Direction.LEFT]: Direction.RIGHT,
    [Direction.RIGHT]: Direction.LEFT,
  };
  return opposites[dir];
};

const generateFood = (snakeBody: Position[]): Position => {
  let newFood: Position;
  do {
    newFood = {
      x: Math.floor(Math.random() * GRID_SIZE),
      y: Math.floor(Math.random() * GRID_SIZE),
    };
  } while (snakeBody.some(segment => segment.x === newFood.x && segment.y === newFood.y));
  return newFood;
};

const getInitialState = (): GameState => {
  const initialSnake: Snake = {
    body: [
      { x: Math.floor(GRID_SIZE / 2), y: Math.floor(GRID_SIZE / 2) },
      { x: Math.floor(GRID_SIZE / 2) - 1, y: Math.floor(GRID_SIZE / 2) },
      { x: Math.floor(GRID_SIZE / 2) - 2, y: Math.floor(GRID_SIZE / 2) },
    ],
  };
  return {
    snake: initialSnake,
    food: { position: generateFood(initialSnake.body) },
    direction: Direction.RIGHT,
    score: 0,
    isGameOver: false,
    isPlaying: false,
  };
};

// === Component ===
export default function SnakeGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gameState, setGameState] = useState<GameState>(getInitialState);
  const [highScore, setHighScore] = useState<number>(0);
  const gameLoopRef = useRef<number | null>(null);
  const directionRef = useRef<Direction>(Direction.RIGHT);

  // Sync direction ref with state
  useEffect(() => {
    directionRef.current = gameState.direction;
  }, [gameState.direction]);

  // Draw game on canvas
  const draw = useCallback((state: GameState) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.fillStyle = COLOR_BACKGROUND;
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Draw grid
    ctx.strokeStyle = COLOR_GRID;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= GRID_SIZE; i++) {
      ctx.beginPath();
      ctx.moveTo(i * CELL_SIZE, 0);
      ctx.lineTo(i * CELL_SIZE, CANVAS_SIZE);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * CELL_SIZE);
      ctx.lineTo(CANVAS_SIZE, i * CELL_SIZE);
      ctx.stroke();
    }

    // Draw food
    ctx.fillStyle = COLOR_FOOD;
    ctx.beginPath();
    ctx.arc(
      state.food.position.x * CELL_SIZE + CELL_SIZE / 2,
      state.food.position.y * CELL_SIZE + CELL_SIZE / 2,
      CELL_SIZE / 2 - 2,
      0,
      Math.PI * 2
    );
    ctx.fill();

    // Draw snake
    state.snake.body.forEach((segment, index) => {
      ctx.fillStyle = index === 0 ? COLOR_SNAKE_HEAD : COLOR_SNAKE;
      ctx.fillRect(
        segment.x * CELL_SIZE + 1,
        segment.y * CELL_SIZE + 1,
        CELL_SIZE - 2,
        CELL_SIZE - 2
      );
    });
  }, []);

  // Game loop
  const gameLoop = useCallback(() => {
    setGameState(prevState => {
      if (prevState.isGameOver || !prevState.isPlaying) return prevState;

      const currentDirection = directionRef.current;
      const velocity = DIRECTION_VELOCITY[currentDirection];
      const head = prevState.snake.body[0];
      const newHead: Position = {
        x: head.x + velocity.x,
        y: head.y + velocity.y,
      };

      // Check wall collision
      if (
        newHead.x < 0 ||
        newHead.x >= GRID_SIZE ||
        newHead.y < 0 ||
        newHead.y >= GRID_SIZE
      ) {
        const finalScore = prevState.score;
        setHighScore(hs => Math.max(hs, finalScore));
        draw({ ...prevState, isGameOver: true });
        return { ...prevState, isGameOver: true };
      }

      // Check self collision
      if (prevState.snake.body.some(segment => segment.x === newHead.x && segment.y === newHead.y)) {
        const finalScore = prevState.score;
        setHighScore(hs => Math.max(hs, finalScore));
        draw({ ...prevState, isGameOver: true });
        return { ...prevState, isGameOver: true };
      }

      // Create new body
      const newBody = [newHead, ...prevState.snake.body];

      // Check food collision
      let newScore = prevState.score;
      let newFood = prevState.food;
      if (newHead.x === prevState.food.position.x && newHead.y === prevState.food.position.y) {
        newScore += 10;
        newFood = { position: generateFood(newBody) };
      } else {
        newBody.pop();
      }

      const newState = {
        ...prevState,
        snake: { body: newBody },
        food: newFood,
        score: newScore,
      };

      draw(newState);
      return newState;
    });
  }, [draw]);

  // Start/Pause game
  const startGame = useCallback(() => {
    setGameState(getInitialState());
    directionRef.current = Direction.RIGHT;
  }, []);

  // Handle keyboard input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (gameState.isGameOver) return;

      let newDirection: Direction | null = null;

      switch (e.key) {
        case 'ArrowUp':
        case 'w':
        case 'W':
          newDirection = Direction.UP;
          break;
        case 'ArrowDown':
        case 's':
        case 'S':
          newDirection = Direction.DOWN;
          break;
        case 'ArrowLeft':
        case 'a':
        case 'A':
          newDirection = Direction.LEFT;
          break;
        case 'ArrowRight':
        case 'd':
        case 'D':
          newDirection = Direction.RIGHT;
          break;
        case ' ':
          e.preventDefault();
          if (!gameState.isPlaying) {
            setGameState(prev => ({ ...prev, isPlaying: true }));
          }
          return;
      }

      if (newDirection && newDirection !== getOppositeDirection(directionRef.current)) {
        directionRef.current = newDirection;
        setGameState(prev => ({ ...prev, direction: newDirection! }));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [gameState.isGameOver, gameState.isPlaying]);

  // Game interval
  useEffect(() => {
    if (gameState.isPlaying && !gameState.isGameOver) {
      gameLoopRef.current = window.setInterval(gameLoop, GAME_SPEED);
    } else {
      if (gameLoopRef.current) {
        clearInterval(gameLoopRef.current);
        gameLoopRef.current = null;
      }
    }

    return () => {
      if (gameLoopRef.current) {
        clearInterval(gameLoopRef.current);
      }
    };
  }, [gameState.isPlaying, gameState.isGameOver, gameLoop]);

  // Initial draw
  useEffect(() => {
    draw(gameState);
  }, [draw, gameState]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '16px',
        padding: '20px',
        backgroundColor: '#0f172a',
        minHeight: '100vh',
      }}
    >
      <h1 style={{ color: '#4ade80', margin: 0, fontSize: '28px', fontWeight: 'bold' }}>
        贪吃蛇 Snake
      </h1>

      <div
        style={{
          display: 'flex',
          gap: '24px',
          color: '#e2e8f0',
          fontSize: '16px',
          fontFamily: 'monospace',
        }}
      >
        <span>分数: <span style={{ color: '#4ade80' }}>{gameState.score}</span></span>
        <span>最高分: <span style={{ color: '#fbbf24' }}>{highScore}</span></span>
      </div>

      <div style={{ position: 'relative' }}>
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          style={{
            border: '2px solid #334155',
            borderRadius: '4px',
          }}
        />

        {!gameState.isPlaying && !gameState.isGameOver && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(15, 23, 42, 0.9)',
              borderRadius: '4px',
            }}
          >
            <p style={{ color: '#e2e8f0', fontSize: '18px', marginBottom: '16px' }}>
              按 空格键 开始游戏
            </p>
            <p style={{ color: '#94a3b8', fontSize: '14px' }}>
              使用 方向键 或 WASD 控制蛇
            </p>
          </div>
        )}

        {gameState.isGameOver && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(15, 23, 42, 0.95)',
              borderRadius: '4px',
            }}
          >
            <p style={{ color: '#ef4444', fontSize: '24px', fontWeight: 'bold', marginBottom: '8px' }}>
              游戏结束
            </p>
            <p style={{ color: '#e2e8f0', fontSize: '18px', marginBottom: '16px' }}>
              最终分数: <span style={{ color: '#4ade80' }}>{gameState.score}</span>
            </p>
            <button
              onClick={startGame}
              style={{
                padding: '10px 24px',
                fontSize: '16px',
                backgroundColor: '#4ade80',
                color: '#0f172a',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 'bold',
              }}
            >
              重新开始
            </button>
          </div>
        )}
      </div>

      <div
        style={{
          color: '#64748b',
          fontSize: '12px',
          textAlign: 'center',
        }}
      >
        <p>方向键 ↑↓←→ 或 WASD 控制移动 | 空格键 暂停/开始</p>
      </div>
    </div>
  );
}
