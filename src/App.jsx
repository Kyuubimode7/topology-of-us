import { useState } from 'react'
import SurfacePair from './SurfacePair.jsx'
import { SHAPES } from './surfaces.js'
import './App.css'

function App() {
  const [tab, setTab] = useState('torus')
  const [steps, setSteps] = useState(20)
  const [seed, setSeed] = useState(1)
  const [replay, setReplay] = useState(0)
  const shape = SHAPES[tab]

  return (
    <main className="page">
      <nav className="tabs" role="tablist">
        {Object.entries(SHAPES).map(([key, shape]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'tab active' : 'tab'}
            onClick={() => setTab(key)}
          >
            {shape.label}
          </button>
        ))}
      </nav>

      <SurfacePair shape={shape} seed={seed} replay={replay} steps={steps} size={600} />

      <div className="controls">
        {shape.animation && (
          <button type="button" onClick={() => setReplay((n) => n + 1)}>
            Replay
          </button>
        )}
        {shape.seeded && (
          <label>
            Seed {seed}
            <input
              type="range"
              min="1"
              max="100"
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value))}
            />
          </label>
        )}
        <label>
          Bands {steps === 0 ? '(smooth)' : steps}
          <input
            type="range"
            min="0"
            max="40"
            value={steps}
            onChange={(e) => setSteps(Number(e.target.value))}
          />
        </label>
      </div>
    </main>
  )
}

export default App
