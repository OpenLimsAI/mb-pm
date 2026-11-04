def test_views_are_account_owned_and_revision_checked(client, auth_headers, iam_user, bearer):
    other = iam_user('saved-view-other', 'rd')
    other_headers = bearer(other, 'rd')
    payload = {'kind': 'tasks', 'name': '本周任务', 'state': {'owner_id': 'me'}}
    response = client.put('/api/v1/pm/views', headers=auth_headers, json=payload)
    assert response.status_code == 200
    view = response.json()
    assert client.get('/api/v1/pm/views', headers=other_headers).json() == []
    assert client.delete('/api/v1/pm/views/' + view['id'], headers=other_headers).status_code == 404
    assert client.put('/api/v1/pm/views', headers=auth_headers, json=payload).status_code == 409
    payload['revision'] = view['revision']
    assert client.put('/api/v1/pm/views', headers=auth_headers, json=payload).json()['revision'] == view['revision'] + 1
    assert client.delete('/api/v1/pm/views/' + view['id'], headers=auth_headers).status_code == 204


def test_view_validation_and_auth(client, auth_headers):
    assert client.get('/api/v1/pm/views').status_code == 401
    assert client.put('/api/v1/pm/views', headers=auth_headers, json={'kind': 'tasks', 'name': ' ', 'state': {}}).status_code == 422
    assert client.put('/api/v1/pm/views', headers=auth_headers, json={'kind': 'tasks', 'name': 'large', 'state': {'x': 'a' * 13000}}).status_code == 422
