pragma solidity 0.7.6;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { IPriceFeed } from "./interface/IPriceFeed.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";

contract VirtualToken is IIndexPrice, Ownable, ERC20 {
    using SafeMath for uint256;

    address public priceFeed;
    address public minter;
    uint8 private immutable _priceFeedDecimals;

    constructor(
        string memory nameArg,
        string memory symbolArg,
        address priceFeedArg
    ) ERC20(nameArg, symbolArg) {
        // BT_IA: invalid address
        require(priceFeedArg != address(0), "BT_IA");

        priceFeed = priceFeedArg;
        _priceFeedDecimals = IPriceFeed(priceFeedArg).decimals();
    }

    /**
     * @dev Destroys `amount` tokens from the caller.
     *
     * See {ERC20-_burn}.
     */
    function burn(uint256 amount) external {
        _burn(_msgSender(), amount);
    }

    function mint(address to, uint256 amount) external virtual {
        // only minter
        require(_msgSender() == minter, "VT_OM");
        _mint(to, amount);
    }

    function setMinter(address minterArg) external onlyOwner {
        minter = minterArg;
    }

    function getIndexPrice(uint256 interval) external view override returns (uint256) {
        return _formatDecimals(IPriceFeed(priceFeed).getPrice(interval));
    }

    function _formatDecimals(uint256 _price) internal view returns (uint256) {
        return _price.mul(10**uint256(decimals())).div(10**uint256(_priceFeedDecimals));
    }
}
