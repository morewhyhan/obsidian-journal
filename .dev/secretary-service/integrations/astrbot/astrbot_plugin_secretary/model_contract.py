"""Compact model-facing projection of the generated contract, not a new validation authority."""
from copy import deepcopy
import json


def model_tool_definition(definition, native, delegated=False):
    result = deepcopy(definition)
    p = result['parameters']
    fields = p.get('properties', {})
    name = result['name']
    if name == 'secretary' and not native:
        # Legacy/background proposal turns submit their actions through submit_proposal.
        for key in ('action_groups', 'decisions', 'commit_mode', 'summary'):
            fields.pop(key, None)
        fields['operation']['enum'] = [v for v in fields['operation']['enum']
            if v not in ('apply_changes', 'save_proposals', 'resolve_proposals')]
    elif name in ('secretary', 'submit_proposal'):
        action = deepcopy(fields['action_groups']['items']['properties']['actions']['items'])
        # Discover detailed command schemas on demand instead of attaching all 50+ commands to every request.
        # This is only a model view: Turn.call and Core still validate the complete generated schema.
        p['$defs'] = {'Action': {'type':'object', 'required':['type'], 'properties':{
            key:action['properties'][key] for key in ('type','target_id','expected_version')}, 'additionalProperties':True,
            'description':'具体动作参数先用secretary.capabilities，query填动作type，取得完整schema后按其提交；不猜字段。'}}
        fields['action_groups']['items']['properties']['actions']['items'] = {'$ref': '#/$defs/Action'}
        if 'decisions' in fields:
            fields['decisions']['items']['properties']['replacements']['items'] = {'$ref': '#/$defs/Action'}
        if native and not delegated:
            # Core binds this genuine incoming instruction itself. Optional historical
            # evidence is not needed to execute it, and working principles are not authority.
            fields['action_groups']['items']['properties'].pop('basis_refs', None)
    return result


def result_text(response):
    text = str(getattr(response, 'completion_text', '') or '').strip()
    if getattr(response, 'role', None) == 'err':
        raise ValueError('MODEL_INPUT_LIMIT' if 'MODEL_INPUT_LIMIT' in text else 'MODEL_PROVIDER_FAILED')
    if not text or 'DSML' in text or '<tool_call>' in text:
        raise ValueError('MODEL_INVALID_FINAL')
    return text


def effect_context(observed):
    """Preserve every outcome/error and its arguments; omit read-only schemas from final wording.
    Retrieval remains available in the original context and tools. Never summarize success from prose.
    """
    effects=[]
    for item in observed:
        args=item.get('arguments', {})
        if item.get('tool')=='get_context' or args.get('operation')=='capabilities':
            continue
        result=item.get('result')
        try: result=json.loads(result) if isinstance(result,str) else result
        except (TypeError,ValueError): pass
        effects.append({'tool':item.get('tool'),'arguments':args,'result':result})
    return effects


def model_view(value):
    """Drop redundant audit envelopes, not business IDs, versions, times or outcomes.
    Core retains and validates full objects; this is a request-local presentation only.
    """
    if isinstance(value,list):
        return [model_view(v) for v in value]
    if not isinstance(value,dict):
        return value
    entity='id' in value and 'version' in value
    return {k:model_view(v) for k,v in value.items()
        if not (entity and k in {'approval','last_operation_id','created_at','updated_at','source','history'})}
