"""Minimal protobuf wire encoding for Cursor ConnectRPC bodies."""

from __future__ import annotations


class ProtobufEncoder:
    @staticmethod
    def encode_varint(value: int) -> bytes:
        out = bytearray()
        while value >= 0x80:
            out.append((value & 0x7F) | 0x80)
            value >>= 7
        out.append(value & 0x7F)
        return bytes(out)

    @staticmethod
    def encode_field(field_num: int, wire_type: int, value) -> bytes:
        tag = (field_num << 3) | wire_type
        result = ProtobufEncoder.encode_varint(tag)
        if wire_type == 0:
            result += ProtobufEncoder.encode_varint(int(value))
        elif wire_type == 2:
            if isinstance(value, str):
                value = value.encode("utf-8")
            elif not isinstance(value, (bytes, bytearray)):
                value = bytes(value)
            result += ProtobufEncoder.encode_varint(len(value)) + bytes(value)
        return result
