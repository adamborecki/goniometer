# goniometer

Real-time browser goniometer with:

- Phase scope (`L` vs `R`)
- Vector scope (`Mid` vs `Side`)
- Correlation meter and RMS readout
- Live microphone input
- Built-in stereo test generator (frequency, phase, width, waveform)

## Run

No build step is required.

1. Start a local server from the project root:

```bash
python3 -m http.server 8080
```

2. Open:

```
http://localhost:8080
```

3. Click `Start` and allow microphone access if using mic input.
