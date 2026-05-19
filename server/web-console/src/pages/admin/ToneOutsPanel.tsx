import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import {
  api,
  describeError,
  uploadToneOutAudio,
  uploadToneOutIcon,
  type ToneOut,
} from "../../api";
import { TONE_OUT_ICON_KINDS, ToneOutIcon } from "../../icons";
import { ToneOutBadge, clearToneOutCache } from "../../toneOuts";

interface ToneOutFormValues {
  name: string;
  playMode: string;
  iconKind: string;
  iconColor: string;
  audio: File | null;
  iconImage: File | null;
  removeImage: boolean;
}

const DEFAULT_COLOR = "#22c5e5";

/** Create/edit field set for one soundboard tone-out. */
function ToneOutForm({
  initial,
  hasImage,
  hasAudio,
  busy,
  onSubmit,
  onDelete,
}: {
  initial: { name: string; playMode: string; iconKind: string; iconColor: string };
  hasImage: boolean;
  hasAudio: boolean;
  busy: boolean;
  onSubmit: (values: ToneOutFormValues) => void;
  onDelete?: () => void;
}) {
  const isCreate = !onDelete;
  const [name, setName] = useState(initial.name);
  const [playMode, setPlayMode] = useState(initial.playMode);
  const [iconKind, setIconKind] = useState(initial.iconKind);
  const [iconColor, setIconColor] = useState(initial.iconColor);
  const [audio, setAudio] = useState<File | null>(null);
  const [iconImage, setIconImage] = useState<File | null>(null);
  const [removeImage, setRemoveImage] = useState(false);

  function pickAudio(event: ChangeEvent<HTMLInputElement>) {
    setAudio(event.target.files?.[0] ?? null);
  }
  function pickImage(event: ChangeEvent<HTMLInputElement>) {
    setIconImage(event.target.files?.[0] ?? null);
    setRemoveImage(false);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({ name: name.trim(), playMode, iconKind, iconColor, audio, iconImage, removeImage });
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="form-row">
        <div className="field">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
          <p className="field-hint">Shown on the tone-out button in every channel panel.</p>
        </div>
        <div className="field">
          <label>Play mode</label>
          <select value={playMode} onChange={(e) => setPlayMode(e.target.value)}>
            <option value="once">Play once</option>
            <option value="loop">Loop until stopped</option>
          </select>
          <p className="field-hint">
            Loop keeps re-keying the clip onto the channel until the operator clicks it again or
            Stop All Sounds.
          </p>
        </div>
        <div className="field">
          <label>Audio clip</label>
          <label className="btn sm filebtn">
            {audio ? "Clip selected" : isCreate ? "Choose audio…" : "Replace audio…"}
            <input type="file" accept="audio/*" hidden onChange={pickAudio} />
          </label>
          <p className="field-hint">
            {audio
              ? audio.name
              : hasAudio
                ? "An audio clip is set — choose a file only to replace it."
                : "WAV, MP3 or OGG, kept short (under 4 MB). Required."}
          </p>
        </div>
      </div>

      <div className="field" style={{ marginTop: 4 }}>
        <label>Button icon</label>
        <div className="toneout-icon-grid">
          {TONE_OUT_ICON_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={kind === iconKind ? "toneout-icon-pick active" : "toneout-icon-pick"}
              onClick={() => setIconKind(kind)}
              title={kind}
            >
              <ToneOutIcon kind={kind} size={18} style={{ color: iconColor }} />
            </button>
          ))}
          <input
            type="color"
            value={iconColor}
            onChange={(e) => setIconColor(e.target.value)}
            title="Icon colour"
          />
        </div>
        <p className="field-hint">
          Pick a built-in glyph and colour. Optionally upload an image below — an uploaded image
          overrides the glyph on the button.
        </p>
        <div className="toneout-image-row">
          <label className="btn sm filebtn">
            {iconImage ? "Image selected" : "Upload image…"}
            <input type="file" accept="image/*" hidden onChange={pickImage} />
          </label>
          {iconImage ? (
            <span className="field-hint">{iconImage.name}</span>
          ) : hasImage && !removeImage ? (
            <>
              <span className="field-hint">Custom image set.</span>
              <button type="button" className="btn sm" onClick={() => setRemoveImage(true)}>
                Remove image
              </button>
            </>
          ) : removeImage ? (
            <>
              <span className="field-hint">Image will be removed.</span>
              <button type="button" className="btn sm" onClick={() => setRemoveImage(false)}>
                Keep image
              </button>
            </>
          ) : (
            <span className="field-hint">Using the built-in glyph.</span>
          )}
        </div>
      </div>

      <div className="sim-channels" style={{ marginTop: 8 }}>
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : isCreate ? "Create tone-out" : "Save"}
        </button>
        {onDelete && (
          <button type="button" className="btn sm danger" onClick={onDelete} disabled={busy}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}

/** Admin panel for the agency's custom soundboard tone-outs. */
export function ToneOutsPanel() {
  const [toneOuts, setToneOuts] = useState<ToneOut[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [createKey, setCreateKey] = useState(0);

  async function reload() {
    try {
      setToneOuts((await api.toneOuts()).toneOuts);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      clearToneOutCache();
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  function create(values: ToneOutFormValues) {
    if (!values.name) {
      setError("Give the tone-out a name.");
      return;
    }
    if (!values.audio) {
      setError("Choose an audio clip for the tone-out.");
      return;
    }
    void run(async () => {
      const { toneOut } = await api.createToneOut({
        name: values.name,
        playMode: values.playMode,
        iconKind: values.iconKind,
        iconColor: values.iconColor,
      });
      await uploadToneOutAudio(toneOut.id, values.audio!);
      if (values.iconImage) {
        await uploadToneOutIcon(toneOut.id, values.iconImage);
      }
      setCreateKey((k) => k + 1);
    });
  }

  function update(toneOut: ToneOut, values: ToneOutFormValues) {
    if (!values.name) {
      setError("Give the tone-out a name.");
      return;
    }
    void run(async () => {
      await api.updateToneOut(toneOut.id, {
        name: values.name,
        playMode: values.playMode,
        iconKind: values.iconKind,
        iconColor: values.iconColor,
      });
      if (values.audio) {
        await uploadToneOutAudio(toneOut.id, values.audio);
      }
      if (values.iconImage) {
        await uploadToneOutIcon(toneOut.id, values.iconImage);
      } else if (values.removeImage) {
        await api.deleteToneOutIcon(toneOut.id);
      }
    });
  }

  function remove(toneOut: ToneOut) {
    if (window.confirm(`Delete tone-out "${toneOut.name}"?`)) {
      void run(() => api.deleteToneOut(toneOut.id));
    }
  }

  return (
    <div>
      <div className="panel-head">
        <h2>Soundboard</h2>
        <span className="count">{toneOuts.length}</span>
      </div>
      <p className="panel-desc">
        Custom tone-outs that supplement the built-in Routine / Priority / Status tones. Each one
        becomes a button in every channel's tone-out row — firing it keys the clip onto that
        channel. Set a name, a built-in icon (or an uploaded image), and whether it plays once or
        loops.
      </p>

      {error && <div className="banner error">{error}</div>}

      <h3>New tone-out</h3>
      <ToneOutForm
        key={createKey}
        initial={{ name: "", playMode: "once", iconKind: "waveform", iconColor: DEFAULT_COLOR }}
        hasImage={false}
        hasAudio={false}
        busy={busy}
        onSubmit={create}
      />

      {loading ? (
        <div className="empty">Loading…</div>
      ) : toneOuts.length === 0 ? (
        <div className="empty">No custom tone-outs yet.</div>
      ) : (
        toneOuts.map((toneOut) => (
          <div key={toneOut.id}>
            <div className="panel-head">
              <h3 className="toneout-row-title">
                <ToneOutBadge toneOut={toneOut} size={18} />
                {toneOut.name}
              </h3>
              <span className="toneout-tags">
                <span className="pill">{toneOut.play_mode === "loop" ? "Loop" : "Once"}</span>
                <span className={toneOut.has_audio ? "pill on" : "pill off"}>
                  {toneOut.has_audio ? "Audio set" : "Needs audio"}
                </span>
              </span>
            </div>
            <ToneOutForm
              key={`${toneOut.id}:${toneOut.has_image}:${toneOut.has_audio}`}
              initial={{
                name: toneOut.name,
                playMode: toneOut.play_mode,
                iconKind: toneOut.icon_kind,
                iconColor: toneOut.icon_color,
              }}
              hasImage={toneOut.has_image}
              hasAudio={toneOut.has_audio}
              busy={busy}
              onSubmit={(values) => update(toneOut, values)}
              onDelete={() => remove(toneOut)}
            />
          </div>
        ))
      )}
    </div>
  );
}
