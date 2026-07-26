import { type Contact } from '../../api';

interface Props {
  contacts: Contact[];
  members: string[];
  reactionRounds: number;
  respondAllByDefault: boolean;
  onToggleMember(id: string): void;
  onReactionRounds(value: number): void;
  onRespondAll(value: boolean): void;
}

export default function RoomFields(props: Props) {
  return (
    <fieldset className="mem-toggles">
      <legend>群成员</legend>
      {props.contacts.map((contact) => (
        <label key={contact.id}>
          <input type="checkbox" checked={props.members.includes(contact.id)} onChange={() => props.onToggleMember(contact.id)} />
          {contact.avatar} {contact.name}
          <span className="field-hint" style={{ marginLeft: 6 }}>({contact.backend})</span>
        </label>
      ))}
      <p className="field-hint">群里用 @名字 点名，@all 叫全员；默认无 @ 时不调用模型，避免无意消耗。</p>
      <label>
        <input type="checkbox" checked={props.respondAllByDefault} onChange={(event) => props.onRespondAll(event.target.checked)} />
        无 @ 时默认全员响应（更热闹，也更耗 token）
      </label>
      <label className="field" style={{ maxWidth: 160 }}>
        接话轮数（0-3）
        <input type="number" min={0} max={3} value={props.reactionRounds} onChange={(event) => props.onReactionRounds(Math.min(3, Math.max(0, Number(event.target.value) || 0)))} />
      </label>
      <p className="field-hint">每轮点名发言后，成员会看到彼此的新发言并可自然接话（或沉默）。0 = 关闭，回到纯点名制。</p>
    </fieldset>
  );
}
