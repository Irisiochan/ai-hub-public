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

const ROUNDS = [0, 1, 2, 3];

export default function RoomFields(props: Props) {
  return (
    <>
      <div className="cfg-group">
        <h3>
          成员 <small>已选 {props.members.length} 个</small>
        </h3>
        <div className="member-list">
          {props.contacts.map((contact) => {
            const on = props.members.includes(contact.id);
            return (
              <button
                key={contact.id}
                type="button"
                className={'member-row' + (on ? ' selected' : '')}
                aria-pressed={on}
                onClick={() => props.onToggleMember(contact.id)}
              >
                <span className="avatar" style={on ? { boxShadow: `inset 0 0 0 1.5px ${contact.color}88` } : undefined}>
                  {contact.avatar}
                </span>
                <span className="member-id">
                  <b>{contact.name}</b>
                  <small>{contact.backend}</small>
                </span>
                <span className="member-check" aria-hidden="true">
                  ✓
                </span>
              </button>
            );
          })}
        </div>
        <p className="cfg-note">群里用 @名字 点名，@all 叫全员；默认无 @ 时不调用模型，避免无意消耗。</p>
      </div>

      <div className="cfg-group">
        <h3>发言规则</h3>
        <div className="switch-row">
          <span>
            <b>无 @ 时默认全员响应</b>
            <small>更热闹，也更耗 token</small>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={props.respondAllByDefault}
            className={'switch' + (props.respondAllByDefault ? ' on' : '')}
            onClick={() => props.onRespondAll(!props.respondAllByDefault)}
          >
            <span className="switch-knob" />
          </button>
        </div>
        <div className="switch-row sub">
          <span>
            <b>互相接话轮数</b>
            <small>成员看到彼此发言后还能再接几轮；0 = 纯点名制</small>
          </span>
          <div className="num-seg" role="group" aria-label="接话轮数">
            {ROUNDS.map((n) => (
              <button
                key={n}
                type="button"
                className={n === props.reactionRounds ? 'selected' : ''}
                onClick={() => props.onReactionRounds(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
