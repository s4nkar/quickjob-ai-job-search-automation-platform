"""add title column to tailoring_sessions

Revision ID: a5e21f8b93d4
Revises: 9b3f0d6a1c84
Create Date: 2026-09-07 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'a5e21f8b93d4'
down_revision: Union[str, None] = '9b3f0d6a1c84'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('tailoring_sessions', sa.Column('title', sa.String(), nullable=True))
    op.create_check_constraint(
        'tailoring_sessions_title_length_check', 'tailoring_sessions',
        'title is null or char_length(title) <= 200',
    )


def downgrade() -> None:
    op.drop_constraint('tailoring_sessions_title_length_check', 'tailoring_sessions', type_='check')
    op.drop_column('tailoring_sessions', 'title')
